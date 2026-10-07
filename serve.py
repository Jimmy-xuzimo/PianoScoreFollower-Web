#!/usr/bin/env python3
"""智能曲谱 · 网页端本地静态服务器。

网页端是纯静态站点（index.html + css + js + assets），但要通过 HTTP 打开而不是
双击 index.html，原因有三：

  1. AudioWorklet 的 addModule() 只在安全上下文可用，file:// 会被拒绝；
  2. 麦克风 getUserMedia 同样要求安全上下文；
  3. 乐谱、字体、SoundFont 都是 fetch/XHR 拉的，file:// 下会被 CORS 拦掉。

localhost 属于安全上下文，所以本机跑这个脚本就够了；对外部署必须上 HTTPS。

用法：
    python serve.py                # 默认 127.0.0.1:8765
    python serve.py --port 9000
    python serve.py --host 0.0.0.0 --port 8765   # 局域网内用手机/平板访问
"""

import argparse
import functools
import http.server
import mimetypes
import os
import socket
import socketserver
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))

# Python 默认的 MIME 表认不出这些扩展名，补上；漏掉 SoundFont 时 alphaTab 会因为
# 拿到的 Content-Type 不对而拒绝解析。
EXTRA_TYPES = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".musicxml": "application/vnd.recordare.musicxml+xml",
    ".xml": "application/vnd.recordare.musicxml+xml",
    ".mid": "audio/midi",
    ".midi": "audio/midi",
    ".sf2": "application/octet-stream",
    ".sf3": "application/octet-stream",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".otf": "font/otf",
    ".wasm": "application/wasm",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    """在 SimpleHTTPRequestHandler 上做两处调整：目录索引 + 开发期禁用缓存。"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # 开发期禁缓存，否则改了 js/css 之后浏览器还在跑旧版本，很容易误判成“没生效”。
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def guess_type(self, path):
        extension = os.path.splitext(path)[1].lower()
        if extension in EXTRA_TYPES:
            return EXTRA_TYPES[extension]
        return mimetypes.guess_type(path)[0] or "application/octet-stream"

    def log_message(self, fmt, *args):
        # 只留错误，正常的资源请求不刷屏。
        if args and str(args[1]).startswith(("4", "5")):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def lan_addresses(port):
    addresses = []
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if ip not in addresses and not ip.startswith("127."):
                addresses.append(ip)
    except OSError:
        pass
    return ["http://%s:%d/" % (ip, port) for ip in addresses]


def main():
    parser = argparse.ArgumentParser(description="智能曲谱 · 网页端本地服务器")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，局域网调试用 0.0.0.0")
    parser.add_argument("--port", type=int, default=8765, help="监听端口")
    args = parser.parse_args()

    handler = functools.partial(Handler)
    with Server((args.host, args.port), handler) as httpd:
        print("智能曲谱 · 网页端已启动")
        print("  本机:  http://127.0.0.1:%d/" % args.port)
        if args.host == "0.0.0.0":
            for url in lan_addresses(args.port):
                print("  局域网: %s" % url)
        print("  目录:  %s" % ROOT)
        print("按 Ctrl+C 停止")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止")


if __name__ == "__main__":
    main()