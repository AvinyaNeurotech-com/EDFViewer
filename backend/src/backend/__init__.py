import json
import math
import os
import tempfile
from asyncio import Lock
from dataclasses import dataclass, field
from hashlib import sha256
from pathlib import Path
from time import time
from uuid import uuid4

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator


app = FastAPI(title="EDF Viewer API")
RECORDINGS_DIR = Path(
    os.environ.get("EDF_DIR", Path(__file__).resolve().parents[2] / "recordings")
).resolve()
MAX_UPLOAD_BYTES = 2 * 1024**3
MAX_UPLOAD_CHUNK_BYTES = 4 * 1024**2
MAX_TREND_BYTES = 128 * 1024**2
TREND_KINDS = {"aeeg", "spectral"}
TREND_MAGIC = b"ETR1"
UPLOADS: dict[str, "UploadSession"] = {}
TREND_SAVE_LOCK = Lock()


@dataclass
class UploadSession:
    path: Path
    name: str
    expected_size: int
    received: int = 0
    lock: Lock = field(default_factory=Lock)


def valid_upload_name(name: str) -> bool:
    return bool(name) and name == Path(name).name and "\\" not in name and not name.startswith(".") and (
        len(name.encode("utf-8")) <= 240 and Path(name).suffix.lower() in {".edf", ".bdf"}
    )


def validate_uploaded_file(path: Path, name: str, size: int) -> None:
    with path.open("rb") as uploaded:
        header = uploaded.read(256)
        if len(header) < 256:
            raise HTTPException(status_code=400, detail="Incomplete EDF/BDF header")
        signal_count = int(header[252:256].strip() or b"0") if header[252:256].strip().isdigit() else 0
        header_size = int(header[184:192].strip() or b"0") if header[184:192].strip().isdigit() else 0
        expected_prefix = b"\xffBIOSEMI" if name.lower().endswith(".bdf") else b"0       "
        if not header.startswith(expected_prefix) or not 1 <= signal_count <= 4096 or header_size != (signal_count + 1) * 256:
            raise HTTPException(status_code=400, detail="Invalid EDF/BDF header")
        uploaded.seek(0)
        full_header = uploaded.read(header_size)
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


def publish_upload(path: Path, name: str, size: int) -> dict[str, str | int]:
    validate_uploaded_file(path, name, size)
    for attempt in range(10):
        destination = RECORDINGS_DIR / (name if attempt == 0 else f"{Path(name).stem}-{uuid4().hex[:8]}{Path(name).suffix}")
        if os.path.lexists(destination):
            continue
        try:
            path.rename(destination)
            return {"name": destination.name, "size": size}
        except FileExistsError:
            continue
    raise HTTPException(status_code=409, detail="Could not allocate a unique recording name")


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


def recording_path(name: str) -> Path:
    file = RECORDINGS_DIR / name
    if (
        name != Path(name).name
        or file.suffix.lower() not in {".edf", ".bdf"}
        or file.is_symlink()
        or not file.is_file()
    ):
        raise HTTPException(status_code=404, detail="Recording not found")
    return file


def recording_revision(file: Path) -> str:
    stat = file.stat()
    return f"{stat.st_size}:{stat.st_mtime_ns}"


def trend_path(file: Path, kind: str) -> Path:
    if kind not in TREND_KINDS:
        raise HTTPException(status_code=404, detail="Trend not found")
    suffix = f".{kind}.v1.bin"
    filename = file.name if len((file.name + suffix).encode()) <= 255 else sha256(file.name.encode()).hexdigest()
    return file.with_name(f"{filename}{suffix}")


def annotation_path(file: Path) -> Path:
    suffix = ".annotations.v1.json"
    filename = file.name if len((file.name + suffix).encode()) <= 255 else sha256(file.name.encode()).hexdigest()
    return file.with_name(f"{filename}{suffix}")


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


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/recordings")
def recordings() -> list[dict[str, str | int]]:
    if not RECORDINGS_DIR.is_dir():
        return []

    return [
        {"name": file.name, "size": file.stat().st_size}
        for file in sorted(RECORDINGS_DIR.iterdir())
        if file.is_file()
        and not file.is_symlink()
        and file.suffix.lower() in {".edf", ".bdf"}
    ]


@app.post("/api/recordings", status_code=201)
async def upload_recording(request: Request, name: str) -> dict[str, str | int]:
    if not valid_upload_name(name):
        raise HTTPException(status_code=400, detail="Choose an .edf or .bdf filename")

    RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=RECORDINGS_DIR, prefix=".upload-", suffix=".part", delete=False
        ) as temporary:
            temporary_path = Path(temporary.name)
            size = 0
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="Recording exceeds 2 GiB upload limit")
                temporary.write(chunk)

        return publish_upload(temporary_path, name, size)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


@app.post("/api/uploads", status_code=201)
def create_upload(name: str, size: int) -> dict[str, str]:
    if not valid_upload_name(name) or not 0 < size <= MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="Invalid recording name or size")
    if len(UPLOADS) >= 8:
        raise HTTPException(status_code=429, detail="Too many active uploads")
    RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
    for stale in RECORDINGS_DIR.glob(".upload-*.part"):
        if stale.is_file() and stale.stat().st_mtime < time() - 86400 and all(
            session.path != stale for session in UPLOADS.values()
        ):
            stale.unlink(missing_ok=True)
    with tempfile.NamedTemporaryFile(dir=RECORDINGS_DIR, prefix=".upload-", suffix=".part", delete=False) as temporary:
        path = Path(temporary.name)
    upload_id = uuid4().hex
    UPLOADS[upload_id] = UploadSession(path, name, size)
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
        with session.path.open("ab") as output:
            output.write(chunk)
        session.received += len(chunk)


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
        destination: Path | None = None
        try:
            result = publish_upload(session.path, session.name, session.received)
            destination = RECORDINGS_DIR / str(result["name"])
            if annotations:
                document = AnnotationDocument(revision=recording_revision(destination), annotations=annotations)
                with tempfile.NamedTemporaryFile(dir=RECORDINGS_DIR, prefix=".annotations-", delete=False) as temporary:
                    temporary_path = Path(temporary.name)
                    try:
                        temporary.write(document.model_dump_json().encode("utf-8"))
                        os.replace(temporary_path, annotation_path(destination))
                    finally:
                        temporary_path.unlink(missing_ok=True)
            return result
        except Exception:
            if destination is not None:
                destination.unlink(missing_ok=True)
            raise
        finally:
            session.path.unlink(missing_ok=True)
            UPLOADS.pop(upload_id, None)


@app.delete("/api/uploads/{upload_id}", status_code=204)
async def cancel_upload(upload_id: str) -> None:
    session = UPLOADS.get(upload_id)
    if session is None:
        return
    async with session.lock:
        if UPLOADS.get(upload_id) is not session:
            return
        session.path.unlink(missing_ok=True)
        UPLOADS.pop(upload_id, None)


@app.get("/api/recordings/{name}/file")
def recording_file(name: str) -> FileResponse:
    return FileResponse(recording_path(name), media_type="application/octet-stream")


@app.get("/api/recordings/{name}/annotations", response_model=AnnotationDocument)
def get_annotations(name: str) -> AnnotationDocument:
    file = recording_path(name)
    revision = recording_revision(file)
    path = annotation_path(file)
    if path.is_symlink():
        raise HTTPException(status_code=400, detail="Invalid annotation file")
    if not path.exists():
        return AnnotationDocument(revision=revision, annotations=[])
    try:
        document = AnnotationDocument.model_validate_json(path.read_bytes())
    except (ValueError, OSError):
        raise HTTPException(status_code=500, detail="Unable to read annotations") from None
    return document if document.revision == revision else AnnotationDocument(revision=revision, annotations=[])


@app.put("/api/recordings/{name}/annotations", status_code=204)
def put_annotations(name: str, document: AnnotationDocument) -> None:
    file = recording_path(name)
    if document.revision != recording_revision(file):
        raise HTTPException(status_code=409, detail="Recording changed; reload annotations")
    path = annotation_path(file)
    if path.is_symlink():
        raise HTTPException(status_code=400, detail="Invalid annotation file")
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=RECORDINGS_DIR, prefix=".annotations-", delete=False) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(document.model_dump_json().encode("utf-8"))
        if document.revision != recording_revision(file):
            raise HTTPException(status_code=409, detail="Recording changed; reload annotations")
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


@app.get("/api/recordings/{name}/trends/revision")
def trend_revision(name: str) -> dict[str, str]:
    return {"revision": recording_revision(recording_path(name))}


@app.get("/api/recordings/{name}/trends/{kind}")
def get_trend(name: str, kind: str) -> FileResponse:
    file = recording_path(name)
    cache = trend_path(file, kind)
    if cache.is_symlink() or not cache.is_file() or cache.stat().st_size > MAX_TREND_BYTES:
        raise HTTPException(status_code=404, detail="Trend not cached")
    try:
        trend_header(cache.read_bytes(), kind, recording_revision(file))
    except (ValueError, UnicodeDecodeError, OSError, KeyError, TypeError):
        raise HTTPException(status_code=404, detail="Trend cache invalid") from None
    return FileResponse(cache, media_type="application/octet-stream")


@app.put("/api/recordings/{name}/trends/{kind}", status_code=204)
async def put_trend(name: str, kind: str, request: Request) -> None:
    file = recording_path(name)
    cache = trend_path(file, kind)
    revision = recording_revision(file)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=RECORDINGS_DIR, prefix=".trend-", delete=False) as temporary:
            temporary_path = Path(temporary.name)
            size = 0
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_TREND_BYTES:
                    raise HTTPException(status_code=413, detail="Trend exceeds size limit")
                temporary.write(chunk)
        try:
            trend_header(temporary_path.read_bytes(), kind, revision)
        except (ValueError, UnicodeDecodeError, KeyError, TypeError):
            raise HTTPException(status_code=400, detail="Invalid or outdated trend cache") from None
        async with TREND_SAVE_LOCK:
            if recording_revision(file) != revision:
                raise HTTPException(status_code=409, detail="Recording changed during upload")
            if cache.is_file() and not cache.is_symlink():
                try:
                    old = trend_header(cache.read_bytes(), kind, revision)
                    new = trend_header(temporary_path.read_bytes(), kind, revision)
                    if old["count"] > new["count"]:
                        raise HTTPException(status_code=409, detail="Newer trend checkpoint already saved")
                except (ValueError, UnicodeDecodeError, OSError, KeyError, TypeError):
                    pass
            os.replace(temporary_path, cache)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
