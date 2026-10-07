import json
import math
import os
import re
from asyncio import Lock
from base64 import b64encode
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from hashlib import sha256
from pathlib import Path, PurePosixPath
from typing import Any
from uuid import uuid4

from azure.core import MatchConditions
from azure.core.exceptions import (
    HttpResponseError,
    ResourceExistsError,
    ResourceModifiedError,
    ResourceNotFoundError,
)
from azure.storage.blob import BlobBlock, BlobProperties
from azure.storage.blob.aio import ContainerClient
from dotenv import load_dotenv
from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field, field_validator


load_dotenv(Path(__file__).resolve().parents[2] / ".env")
CONTAINER_NAME = os.environ.get("AZURE_STORAGE_CONTAINER", "recordings")
MAX_UPLOAD_BYTES = 2 * 1024**3
MAX_UPLOAD_CHUNK_BYTES = 4 * 1024**2
MAX_HEADER_BYTES = 4097 * 256
MAX_TREND_BYTES = 128 * 1024**2
TREND_KINDS = {"aeeg", "spectral"}
TREND_MAGIC = b"ETR1"
RANGE_PATTERN = re.compile(r"bytes=(\d*)-(\d*)")
UPLOADS: dict[str, "UploadSession"] = {}
TREND_SAVE_LOCK = Lock()
container: ContainerClient


def container_client() -> tuple[ContainerClient, Any]:
    """Connect with AZURE_STORAGE_CONNECTION_STRING, or AZURE_STORAGE_ACCOUNT_URL plus Entra ID credentials."""
    connection_string = os.environ.get("AZURE_STORAGE_CONNECTION_STRING")
    if connection_string:
        return ContainerClient.from_connection_string(connection_string, CONTAINER_NAME), None
    account_url = os.environ.get("AZURE_STORAGE_ACCOUNT_URL")
    if not account_url:
        raise RuntimeError("Set AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT_URL")
    from azure.identity.aio import DefaultAzureCredential

    credential = DefaultAzureCredential()
    return ContainerClient(account_url, CONTAINER_NAME, credential=credential), credential


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    global container
    client, credential = container_client()
    try:
        async with client:
            if not await client.exists():
                try:
                    await client.create_container()
                except ResourceExistsError:
                    pass
            container = client
            yield
    finally:
        if credential is not None:
            await credential.close()


app = FastAPI(title="EDF Viewer API", lifespan=lifespan)


@dataclass
class UploadSession:
    """Blocks are staged on the final blob name and only become visible when the block list is committed."""
    name: str
    expected_size: int
    received: int = 0
    header: bytearray = field(default_factory=bytearray)
    blocks: list[BlobBlock] = field(default_factory=list)
    lock: Lock = field(default_factory=Lock)

    async def stage(self, chunk: bytes) -> None:
        block_id = b64encode(f"{uuid4().hex}-{len(self.blocks):06d}".encode()).decode()
        await container.get_blob_client(self.name).stage_block(block_id, chunk, length=len(chunk))
        self.blocks.append(BlobBlock(block_id))
        if len(self.header) < MAX_HEADER_BYTES:
            self.header.extend(chunk[:MAX_HEADER_BYTES - len(self.header)])
        self.received += len(chunk)


def valid_upload_name(name: str) -> bool:
    return bool(name) and name == PurePosixPath(name).name and "\\" not in name and not name.startswith(".") and (
        len(name.encode("utf-8")) <= 240 and PurePosixPath(name).suffix.lower() in {".edf", ".bdf"}
    )


def validate_uploaded_header(full_header: bytes, name: str, size: int) -> None:
    header = full_header[:256]
    if len(header) < 256:
        raise HTTPException(status_code=400, detail="Incomplete EDF/BDF header")
    signal_count = int(header[252:256].strip() or b"0") if header[252:256].strip().isdigit() else 0
    header_size = int(header[184:192].strip() or b"0") if header[184:192].strip().isdigit() else 0
    expected_prefix = b"\xffBIOSEMI" if name.lower().endswith(".bdf") else b"0       "
    if not header.startswith(expected_prefix) or not 1 <= signal_count <= 4096 or header_size != (signal_count + 1) * 256:
        raise HTTPException(status_code=400, detail="Invalid EDF/BDF header")
    full_header = full_header[:header_size]
    if len(full_header) != header_size:
        raise HTTPException(status_code=400, detail="Incomplete EDF/BDF header")
    try:
        record_count = int(header[236:244].strip())
        record_duration = float(header[244:252].strip())
        offset = 256 + signal_count * 216
        samples = [int(full_header[offset + index * 8:offset + (index + 1) * 8].strip())
                   for index in range(signal_count)]
        record_bytes = sum(samples) * (3 if name.lower().endswith(".bdf") else 2)
    except (ValueError, OverflowError):
        raise HTTPException(status_code=400, detail="Invalid EDF/BDF data layout") from None
    if record_count <= 0 or not math.isfinite(record_duration) or record_duration <= 0 or any(
        sample < 0 for sample in samples
    ) or record_bytes <= 0 or header_size + record_count * record_bytes != size:
        raise HTTPException(status_code=400, detail="Incomplete EDF/BDF data records")


async def blob_exists(name: str) -> bool:
    return await container.get_blob_client(name).exists()


async def allocate_recording_name(name: str) -> str:
    reserved = {session.name for session in UPLOADS.values()}
    for attempt in range(10):
        candidate = name if attempt == 0 else f"{PurePosixPath(name).stem}-{uuid4().hex[:8]}{PurePosixPath(name).suffix}"
        if candidate not in reserved and not await blob_exists(candidate):
            return candidate
    raise HTTPException(status_code=409, detail="Could not allocate a unique recording name")


async def publish_upload(session: UploadSession) -> dict[str, str | int]:
    validate_uploaded_header(bytes(session.header), session.name, session.received)
    try:
        await container.get_blob_client(session.name).commit_block_list(
            session.blocks, match_condition=MatchConditions.IfMissing
        )
    except (ResourceExistsError, ResourceModifiedError):
        raise HTTPException(status_code=409, detail="A recording with this name was just created; upload again") from None
    return {"name": session.name, "size": session.received}


class Annotation(BaseModel):
    id: float = Field(ge=0, allow_inf_nan=False)
    time: float = Field(ge=0, allow_inf_nan=False)
    duration: float = Field(ge=0, allow_inf_nan=False)
    label: str = Field(min_length=1, max_length=80)
    visible: bool

    @field_validator("label")
    @classmethod
    def nonempty_label(cls, label: str) -> str:
        if not label.strip():
            raise ValueError("Annotation label must not be blank")
        return label.strip()


class AnnotationDocument(BaseModel):
    version: int = Field(default=1, ge=1, le=1)
    revision: str = Field(max_length=120)
    annotations: list[Annotation] = Field(max_length=10000)


def valid_recording_name(name: str) -> bool:
    return name == PurePosixPath(name).name and "\\" not in name and (
        PurePosixPath(name).suffix.lower() in {".edf", ".bdf"}
    )


async def recording_properties(name: str) -> BlobProperties:
    if not valid_recording_name(name):
        raise HTTPException(status_code=404, detail="Recording not found")
    try:
        return await container.get_blob_client(name).get_blob_properties()
    except ResourceNotFoundError:
        raise HTTPException(status_code=404, detail="Recording not found") from None


def recording_revision(properties: BlobProperties) -> str:
    return f"{properties.size}:{str(properties.etag).strip('"')}"


async def current_revision(name: str) -> str:
    return recording_revision(await recording_properties(name))


def sidecar_name(name: str, suffix: str) -> str:
    return f"{name if len((name + suffix).encode()) <= 255 else sha256(name.encode()).hexdigest()}{suffix}"


def trend_name(name: str, kind: str) -> str:
    if kind not in TREND_KINDS:
        raise HTTPException(status_code=404, detail="Trend not found")
    return sidecar_name(name, f".{kind}.v1.bin")


def annotation_name(name: str) -> str:
    return sidecar_name(name, ".annotations.v1.json")


def trend_header(data: bytes, kind: str, revision: str) -> dict:
    if len(data) < 8 or data[:4] != TREND_MAGIC:
        raise ValueError("Invalid trend format")
    length = int.from_bytes(data[4:8], "little")
    if length > 4096 or len(data) < 8 + length:
        raise ValueError("Invalid trend header")
    metadata = json.loads(data[8:8 + length])
    if not isinstance(metadata, dict) or metadata.get("kind") != kind or metadata.get("revision") != revision:
        raise ValueError("Outdated trend cache")
    pairs = metadata.get("pairs")
    count = metadata.get("count")
    if not isinstance(pairs, list) or not pairs or len(pairs) > 16 or not all(
        isinstance(pair, str) and 0 < len(pair) <= 100 for pair in pairs
    ) or type(count) is not int or count < 0:
        raise ValueError("Invalid trend dimensions")
    floats_per_epoch = len(pairs) * 3 if kind == "aeeg" else 75
    if len(data) != 8 + length + count * floats_per_epoch * 4:
        raise ValueError("Invalid trend length")
    return metadata


async def read_limited(request: Request, limit: int, detail: str) -> bytes:
    data = bytearray()
    async for part in request.stream():
        data.extend(part)
        if len(data) > limit:
            raise HTTPException(status_code=413, detail=detail)
    return bytes(data)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/recordings")
async def recordings() -> list[dict[str, str | int]]:
    return [
        {"name": blob.name, "size": blob.size}
        async for blob in container.list_blobs()
        if not blob.name.startswith(".") and valid_recording_name(blob.name)
    ]


@app.post("/api/recordings", status_code=201)
async def upload_recording(request: Request, name: str) -> dict[str, str | int]:
    if not valid_upload_name(name):
        raise HTTPException(status_code=400, detail="Choose an .edf or .bdf filename")
    upload_id = uuid4().hex
    session = UPLOADS[upload_id] = UploadSession(await allocate_recording_name(name), MAX_UPLOAD_BYTES)
    try:
        buffer = bytearray()
        async for part in request.stream():
            buffer.extend(part)
            if session.received + len(buffer) > MAX_UPLOAD_BYTES:
                raise HTTPException(status_code=413, detail="Recording exceeds 2 GiB upload limit")
            if len(buffer) >= MAX_UPLOAD_CHUNK_BYTES:
                await session.stage(bytes(buffer))
                buffer.clear()
        if buffer:
            await session.stage(bytes(buffer))
        return await publish_upload(session)
    finally:
        UPLOADS.pop(upload_id, None)


@app.post("/api/uploads", status_code=201)
async def create_upload(name: str, size: int) -> dict[str, str]:
    if not valid_upload_name(name) or not 0 < size <= MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="Invalid recording name or size")
    if len(UPLOADS) >= 8:
        raise HTTPException(status_code=429, detail="Too many active uploads")
    upload_id = uuid4().hex
    UPLOADS[upload_id] = UploadSession(await allocate_recording_name(name), size)
    return {"id": upload_id}


@app.put("/api/uploads/{upload_id}", status_code=204)
async def append_upload(upload_id: str, offset: int, request: Request) -> None:
    session = UPLOADS.get(upload_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Upload not found")
    async with session.lock:
        if UPLOADS.get(upload_id) is not session:
            raise HTTPException(status_code=404, detail="Upload not found")
        if offset != session.received:
            raise HTTPException(status_code=409, detail="Unexpected upload offset")
        chunk = bytearray()
        async for part in request.stream():
            chunk.extend(part)
            if len(chunk) > MAX_UPLOAD_CHUNK_BYTES or session.received + len(chunk) > session.expected_size:
                raise HTTPException(status_code=413, detail="Upload chunk exceeds limit")
        if not chunk:
            raise HTTPException(status_code=400, detail="Empty upload chunk")
        await session.stage(bytes(chunk))


@app.post("/api/uploads/{upload_id}/complete", status_code=201)
async def complete_upload(upload_id: str, annotations: list[Annotation] = Body(default=[], max_length=10000)) -> dict[str, str | int]:
    session = UPLOADS.get(upload_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Upload not found")
    async with session.lock:
        if UPLOADS.get(upload_id) is not session:
            raise HTTPException(status_code=404, detail="Upload not found")
        if session.received != session.expected_size:
            raise HTTPException(status_code=409, detail="Upload incomplete")
        published = False
        try:
            result = await publish_upload(session)
            published = True
            if annotations:
                document = AnnotationDocument(revision=await current_revision(session.name), annotations=annotations)
                await container.get_blob_client(annotation_name(session.name)).upload_blob(
                    document.model_dump_json().encode("utf-8"), overwrite=True
                )
            return result
        except Exception:
            if published:
                await container.get_blob_client(session.name).delete_blob()
            raise
        finally:
            UPLOADS.pop(upload_id, None)


@app.delete("/api/uploads/{upload_id}", status_code=204)
async def cancel_upload(upload_id: str) -> None:
    # Staged blocks that are never committed are discarded by Blob Storage after seven days.
    session = UPLOADS.get(upload_id)
    if session is None:
        return
    async with session.lock:
        if UPLOADS.get(upload_id) is session:
            UPLOADS.pop(upload_id, None)


@app.get("/api/recordings/{name}/file")
async def recording_file(name: str, request: Request) -> Response:
    if not valid_recording_name(name):
        raise HTTPException(status_code=404, detail="Recording not found")
    blob = container.get_blob_client(name)
    match = RANGE_PATTERN.fullmatch(request.headers.get("range", "").strip())
    if match and not match[1] and match[2]:
        # Suffix range ("bytes=-N") needs the blob size to resolve.
        size = (await recording_properties(name)).size
        start, end = max(size - int(match[2]), 0), size - 1
        if int(match[2]) == 0 or size == 0:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
    elif match and match[1] and (not match[2] or int(match[2]) >= int(match[1])):
        start, end = int(match[1]), int(match[2]) if match[2] else None
    else:
        start = end = None
    try:
        downloader = await blob.download_blob(
            offset=start, length=None if start is None or end is None else end - start + 1
        )
    except ResourceNotFoundError:
        raise HTTPException(status_code=404, detail="Recording not found") from None
    except HttpResponseError as error:
        if error.status_code == 416:
            size = (await recording_properties(name)).size
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
        raise
    headers = {"Accept-Ranges": "bytes", "Content-Length": str(downloader.size)}
    if start is None:
        return StreamingResponse(downloader.chunks(), media_type="application/octet-stream", headers=headers)
    total = downloader.properties.content_range.rsplit("/", 1)[1]
    if downloader.size <= 0 or start >= int(total):
        return Response(status_code=416, headers={"Content-Range": f"bytes */{total}"})
    headers["Content-Range"] = f"bytes {start}-{start + downloader.size - 1}/{total}"
    return StreamingResponse(downloader.chunks(), status_code=206, media_type="application/octet-stream", headers=headers)


@app.get("/api/recordings/{name}/annotations", response_model=AnnotationDocument)
async def get_annotations(name: str) -> AnnotationDocument:
    revision = await current_revision(name)
    try:
        data = await (await container.get_blob_client(annotation_name(name)).download_blob()).readall()
    except ResourceNotFoundError:
        return AnnotationDocument(revision=revision, annotations=[])
    try:
        document = AnnotationDocument.model_validate_json(data)
    except ValueError:
        raise HTTPException(status_code=500, detail="Unable to read annotations") from None
    return document if document.revision == revision else AnnotationDocument(revision=revision, annotations=[])


@app.put("/api/recordings/{name}/annotations", status_code=204)
async def put_annotations(name: str, document: AnnotationDocument) -> None:
    if document.revision != await current_revision(name):
        raise HTTPException(status_code=409, detail="Recording changed; reload annotations")
    await container.get_blob_client(annotation_name(name)).upload_blob(
        document.model_dump_json().encode("utf-8"), overwrite=True
    )


@app.get("/api/recordings/{name}/trends/revision")
async def trend_revision(name: str) -> dict[str, str]:
    return {"revision": await current_revision(name)}


@app.get("/api/recordings/{name}/trends/{kind}")
async def get_trend(name: str, kind: str) -> Response:
    revision = await current_revision(name)
    try:
        downloader = await container.get_blob_client(trend_name(name, kind)).download_blob()
    except ResourceNotFoundError:
        raise HTTPException(status_code=404, detail="Trend not cached") from None
    if downloader.size > MAX_TREND_BYTES:
        raise HTTPException(status_code=404, detail="Trend not cached")
    data = await downloader.readall()
    try:
        trend_header(data, kind, revision)
    except (ValueError, UnicodeDecodeError, KeyError, TypeError):
        raise HTTPException(status_code=404, detail="Trend cache invalid") from None
    return Response(data, media_type="application/octet-stream")


@app.put("/api/recordings/{name}/trends/{kind}", status_code=204)
async def put_trend(name: str, kind: str, request: Request) -> None:
    revision = await current_revision(name)
    cache = container.get_blob_client(trend_name(name, kind))
    data = await read_limited(request, MAX_TREND_BYTES, "Trend exceeds size limit")
    try:
        new = trend_header(data, kind, revision)
    except (ValueError, UnicodeDecodeError, KeyError, TypeError):
        raise HTTPException(status_code=400, detail="Invalid or outdated trend cache") from None
    async with TREND_SAVE_LOCK:
        if await current_revision(name) != revision:
            raise HTTPException(status_code=409, detail="Recording changed during upload")
        condition: dict[str, Any] = {"match_condition": MatchConditions.IfMissing}
        try:
            downloader = await cache.download_blob()
            condition = {"etag": downloader.properties.etag, "match_condition": MatchConditions.IfNotModified}
            old = trend_header(await downloader.readall(), kind, revision)
            if old["count"] > new["count"]:
                raise HTTPException(status_code=409, detail="Newer trend checkpoint already saved")
        except ResourceNotFoundError:
            pass
        except (ValueError, UnicodeDecodeError, KeyError, TypeError):
            pass
        try:
            await cache.upload_blob(data, overwrite=True, **condition)
        except (ResourceExistsError, ResourceModifiedError):
            raise HTTPException(status_code=409, detail="Trend checkpoint changed during save; retry") from None
