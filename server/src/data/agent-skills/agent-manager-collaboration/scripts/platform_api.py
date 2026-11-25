#!/usr/bin/env python3
"""Call the collaboration API supplied to an Agent Manager tab."""
import argparse
import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

MAX_INPUT_BYTES = 256 * 1024
MAX_RESPONSE_BYTES = 1024 * 1024

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("capabilities")
    tabs = commands.add_parser("list-tabs")
    tabs.add_argument("--cursor")
    options = commands.add_parser("execution-options")
    options.add_argument("--agent-id")
    options.add_argument("--include-quota", action="store_true")
    commands.add_parser("create-tab", help="Read the creation request JSON from stdin")
    commands.add_parser("send-message", help="Read the delivery request JSON from stdin")
    operation = commands.add_parser("operation")
    operation.add_argument("request_id")
    return parser.parse_args()


def platform_connection():
    url = os.environ.get("AGENT_MANAGER_COLLABORATION_URL", "")
    token = os.environ.get("AGENT_MANAGER_COLLABORATION_TOKEN", "")
    if not url or not token:
        raise ValueError("当前运行时未提供 Agent Manager 协作连接")
    if any(char.isspace() for char in url) or any(ord(char) < 33 or ord(char) > 126 for char in token):
        raise ValueError("协作连接配置无效")
    base = urlsplit(url)
    secure = base.scheme == "https" or base.scheme == "http" and base.hostname in ("127.0.0.1", "::1")
    if (not secure or not base.hostname or base.username is not None
            or base.password is not None or base.query or base.fragment or not base.path.startswith("/")):
        raise ValueError("协作连接需要 HTTPS 或本机回环地址")
    return base, token


def make_request(args):
    command = args.command
    query = {}
    if command == "capabilities":
        route = "/capabilities"
    elif command == "list-tabs":
        route = "/tabs"
        if args.cursor:
            query["cursor"] = args.cursor
    elif command == "execution-options":
        route = "/execution-options"
        if args.agent_id:
            query["agent_id"] = args.agent_id
        if args.include_quota:
            query["include_quota"] = "true"
    elif command == "operation":
        if not args.request_id or args.request_id in (".", ".."):
            raise ValueError("需要有效的 request_id")
        route = "/operations/" + quote(args.request_id, safe="")
    else:
        body = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(body) > MAX_INPUT_BYTES:
            raise ValueError("请求正文过大")
        try:
            value = json.loads(body)
        except (ValueError, RecursionError):
            raise ValueError("请求正文必须是 JSON 对象") from None
        if not isinstance(value, dict) or not isinstance(value.get("request_id"), str) or not value["request_id"].strip():
            raise ValueError("请求正文必须包含 request_id")
        return ("/tabs" if command == "create-tab" else "/messages"), "", body
    return route, urlencode(query), None


def print_response(response, token):
    data = response.read(MAX_RESPONSE_BYTES + 1)
    if len(data) > MAX_RESPONSE_BYTES:
        raise ValueError("协作 API 响应过大")
    try:
        value = json.loads(data)
        if not isinstance(value, dict):
            raise ValueError()
        result = json.dumps(value, ensure_ascii=False)
        if token in result:
            raise ValueError()
    except (ValueError, RecursionError):
        raise ValueError("协作 API 未返回可读取的 JSON 对象") from None
    print(result)


def main():
    args = parse_args()
    try:
        base, token = platform_connection()
        route, query, body = make_request(args)
        url = urlunsplit((base.scheme, base.netloc, base.path.rstrip("/") + route, query, ""))
        headers = {"Authorization": "Bearer " + token, "Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = Request(url, data=body, headers=headers)
        opener = build_opener(ProxyHandler({}), NoRedirect())
        with opener.open(request, timeout=30) as response:
            print_response(response, token)
        return 0
    except HTTPError as error:
        try:
            print_response(error, token)
        except (ValueError, OSError):
            pass
        finally:
            error.close()
        print(f"协作 API 返回 HTTP {error.code}", file=sys.stderr)
    except (URLError, OSError, TimeoutError):
        print("协作 API 连接未确认。提交操作请用原 request_id 查询状态。", file=sys.stderr)
    except ValueError as error:
        print(str(error), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
