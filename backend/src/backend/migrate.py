"""Copy recordings and their sidecars from a directory (e.g. a mounted Azure File Share) into Blob Storage.

Sidecars are tied to a recording revision, which changes from `size:mtime_ns` on the file share to
`size:etag` in Blob Storage, so annotation documents and trend headers are rewritten with the new revision.

    uv run python -m backend.migrate /mnt/recordings [--ignore-revision]
"""

import argparse
import asyncio
import json
from pathlib import Path

from azure.core.exceptions import ResourceExistsError, ResourceNotFoundError

from backend import (
    TREND_KINDS,
    TREND_MAGIC,
    AnnotationDocument,
    annotation_name,
    container_client,
    recording_revision,
    trend_header,
    trend_name,
    valid_recording_name,
)


def rewrite_trend(data: bytes, kind: str, old: str | None, new: str) -> bytes:
    length = int.from_bytes(data[4:8], "little")
    metadata = json.loads(data[8:8 + length])
    if old is not None:
        trend_header(data, kind, old)
    metadata["revision"] = new
    encoded = json.dumps(metadata, separators=(",", ":")).encode("utf-8")
    result = TREND_MAGIC + len(encoded).to_bytes(4, "little") + encoded + data[8 + length:]
    trend_header(result, kind, new)
    return result


async def migrate(source: Path, ignore_revision: bool) -> None:
    client, credential = container_client()
    try:
        async with client:
            try:
                await client.create_container()
            except ResourceExistsError:
                pass
            for file in sorted(source.iterdir()):
                if file.is_symlink() or not file.is_file() or file.name.startswith(".") or not valid_recording_name(file.name):
                    continue
                stat = file.stat()
                old = None if ignore_revision else f"{stat.st_size}:{stat.st_mtime_ns}"
                blob = client.get_blob_client(file.name)
                try:
                    with file.open("rb") as data:
                        await blob.upload_blob(data, length=stat.st_size, max_concurrency=4, overwrite=False)
                    print(f"uploaded   {file.name}")
                except ResourceExistsError:
                    print(f"exists     {file.name} (sidecars still refreshed)")
                try:
                    new = recording_revision(await blob.get_blob_properties())
                except ResourceNotFoundError:
                    continue

                annotations = source / annotation_name(file.name)
                if annotations.is_file() and not annotations.is_symlink():
                    try:
                        document = AnnotationDocument.model_validate_json(annotations.read_bytes())
                        if old is not None and document.revision != old:
                            raise ValueError(f"revision {document.revision!r} does not match {old!r}")
                        document.revision = new
                        await client.get_blob_client(annotation_name(file.name)).upload_blob(
                            document.model_dump_json().encode("utf-8"), overwrite=True
                        )
                        print(f"  annotations ({len(document.annotations)})")
                    except ValueError as error:
                        print(f"  skipped annotations: {error}")

                for kind in sorted(TREND_KINDS):
                    trend = source / trend_name(file.name, kind)
                    if not trend.is_file() or trend.is_symlink():
                        continue
                    try:
                        data = rewrite_trend(trend.read_bytes(), kind, old, new)
                        await client.get_blob_client(trend_name(file.name, kind)).upload_blob(data, overwrite=True)
                        print(f"  {kind} trend")
                    except (ValueError, UnicodeDecodeError, KeyError, TypeError) as error:
                        print(f"  skipped {kind} trend: {error}")
    finally:
        if credential is not None:
            await credential.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("source", type=Path, help="Directory holding the existing .edf/.bdf recordings and sidecars")
    parser.add_argument("--ignore-revision", action="store_true",
                        help="Migrate sidecars even if their size:mtime revision no longer matches the source file "
                             "(e.g. after copying the share with a tool that did not preserve modification times)")
    arguments = parser.parse_args()
    asyncio.run(migrate(arguments.source, arguments.ignore_revision))


if __name__ == "__main__":
    main()
