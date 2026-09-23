"""Read a PDF and its password through stdin; return a decrypted local derivative.

No source file is modified. Never write passwords, raw PDFs, or exception messages
to stderr. The caller imposes a wall-clock timeout in addition to these byte limits.
"""
import base64
import io
import json
import logging
import sys

MAX_BYTES = 64 * 1024 * 1024
MAX_REQUEST_BYTES = ((MAX_BYTES + 2) // 3) * 4 + 32768
logging.disable(logging.CRITICAL)


def reply(**result):
    sys.stdout.write(json.dumps(result, ensure_ascii=True, separators=(",", ":")))


class LimitedBuffer(io.BytesIO):
    def write(self, data):
        if self.tell() + len(data) > MAX_BYTES:
            raise OverflowError()
        return super().write(data)


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            reply(ok=False, code="too_large")
            return
        request = json.loads(raw)
        password = request["password"]
        encoded = request["data"]
        if not isinstance(password, str) or len(password.encode("utf-8")) > 4096 or not isinstance(encoded, str):
            raise ValueError()
        data = base64.b64decode(encoded, validate=True)
    except Exception:
        reply(ok=False, code="invalid_request")
        return
    if len(data) > MAX_BYTES:
        reply(ok=False, code="too_large")
        return
    try:
        import cryptography  # noqa: F401 - AES PDF support must be available.
        from pypdf import PdfReader, PdfWriter
        from pypdf.errors import PdfReadError, DependencyError
    except ImportError:
        reply(ok=False, code="missing_dependencies")
        return
    try:
        reader = PdfReader(io.BytesIO(data), strict=False)
        if not reader.is_encrypted:
            reply(ok=True, encrypted=False)
            return
        if not reader.decrypt(password):
            reply(ok=False, code="incorrect_password")
            return
        writer = PdfWriter(clone_from=reader)
        output = LimitedBuffer()
        writer.write(output)
        reply(ok=True, encrypted=True, data=base64.b64encode(output.getvalue()).decode("ascii"))
    except OverflowError:
        reply(ok=False, code="too_large")
    except DependencyError:
        reply(ok=False, code="missing_dependencies")
    except NotImplementedError:
        reply(ok=False, code="unsupported_encryption")
    except PdfReadError:
        reply(ok=False, code="invalid_pdf")
    except Exception:
        reply(ok=False, code="decryption_failed")


if __name__ == "__main__":
    main()
