#!/usr/bin/env python3

import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


MODELS = [
    {
        "id": "smoke-standard",
        "owned_by": "mock-provider",
        "call_methods": ["chat.completions"],
    },
    {
        "id": "smoke-thinking",
        "owned_by": "mock-provider",
        "call_methods": ["chat.completions"],
    },
    {
        "id": "gpt-5.5-smoke",
        "owned_by": "openai",
        "call_methods": ["chat.completions", "responses"],
        "supported_parameters": ["reasoning"],
    },
]


def extract_prompt(payload):
    messages = payload.get("messages") or payload.get("input") or []
    if isinstance(messages, str):
        return messages
    if not messages:
        return ""

    content = messages[-1].get("content", "")
    if isinstance(content, list):
        text_parts = []
        for part in content:
            if part.get("type") in ("text", "input_text"):
                text_parts.append(part.get("text", ""))
        return "\n".join(text_parts)
    return str(content)


class Handler(BaseHTTPRequestHandler):
    server_version = "ZhidaSmokeAPI/1.0"

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        if self.path == "/v1/models":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"data": MODELS}).encode("utf-8"))
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path.startswith("/v1/responses/") and self.path.endswith("/cancel"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "cancelled"}).encode("utf-8"))
            return

        if self.path == "/v1/responses":
            length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(length)
            payload = json.loads(raw_body.decode("utf-8") or "{}")
            prompt = extract_prompt(payload).lower()
            has_search = any(tool.get("type") == "web_search" for tool in payload.get("tools", []))
            effort = (payload.get("reasoning") or {}).get("effort", "")

            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Connection", "keep-alive")
            self.end_headers()

            self.wfile.write(b'event: response.created\ndata: {"id":"resp_smoke"}\n\n')
            if has_search:
                self.wfile.write(b'event: response.output_item.added\ndata: {"item":{"type":"web_search_call"}}\n\n')
                self.write_response_sse("Responses search reply")
            elif "reasoning check" in prompt:
                self.write_response_sse(f"reasoning: {effort}")
            else:
                self.write_response_sse("Responses reply")
            self.wfile.write(
                b'event: response.completed\ndata: {"response":{"output":[{"content":[{"annotations":[{"type":"url_citation","url":"https://example.com/source","title":"Example Source"}]}]}]}}\n\n'
            )
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            self.close_connection = True
            return

        if self.path != "/v1/chat/completions":
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length)
        payload = json.loads(raw_body.decode("utf-8") or "{}")
        prompt = extract_prompt(payload).lower()
        is_stream = payload.get("stream", False)

        if not is_stream:
            body = {
                "id": "mock-completion",
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "Smoke test reply",
                        }
                    }
                ],
            }
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(body).encode("utf-8"))
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        try:
            if "echo model" in prompt:
                self.write_sse({"choices": [{"delta": {"content": f"model: {payload.get('model', '')}"}}]})
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                return

            if "slow" in prompt:
                self.write_sse({"choices": [{"delta": {"content": "Partial "}}]})
                time.sleep(1.5)
                self.write_sse({"choices": [{"delta": {"content": "reply"}}]})
                time.sleep(1.0)
            else:
                self.write_sse({"choices": [{"delta": {"content": "Smoke test reply"}}]})

            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except BrokenPipeError:
            return

    def write_sse(self, payload):
        message = f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")
        self.wfile.write(message)
        self.wfile.flush()

    def write_response_sse(self, text):
        message = (
            "event: response.output_text.delta\n"
            f"data: {json.dumps({'delta': text}, ensure_ascii=False)}\n\n"
        ).encode("utf-8")
        self.wfile.write(message)
        self.wfile.flush()

    def log_message(self, format, *args):
        return


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 11434
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Mock API listening on http://127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
