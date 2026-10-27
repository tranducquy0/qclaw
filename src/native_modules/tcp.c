/* tcp.c — raw socket primitives (IRC phase 3; plain TCP).
 * fd-based API; keeps line assembly in JS (see adapters/qjs.js). */
#include <string.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#include "common.h"

static JSValue js_connecttcp(JSContext *ctx, JSValueConst t,
                             int argc, JSValueConst *argv)
{
    const char *host = JS_ToCString(ctx, argv[0]);
    int32_t port = 6667;
    JS_ToInt32(ctx, &port, argv[1]);
    if (!host) return JS_EXCEPTION;

    struct addrinfo hints = {0}, *res = NULL;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_family = AF_UNSPEC;
    if (getaddrinfo(host, NULL, &hints, &res) != 0 || !res) {
        JS_FreeCString(ctx, host);
        return JS_ThrowInternalError(ctx, "dns fail: %s", host);
    }
    int fd = -1;
    for (struct addrinfo *ai = res; ai; ai = ai->ai_next) {
        if (ai->ai_family == AF_INET || ai->ai_family == AF_INET6) {
            if (ai->ai_family == AF_INET)
                ((struct sockaddr_in *)ai->ai_addr)->sin_port = htons(port);
            else
                ((struct sockaddr_in6 *)ai->ai_addr)->sin6_port = htons(port);
            fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
            if (fd < 0) continue;
            if (connect(fd, ai->ai_addr, ai->ai_addrlen) == 0) break;
            close(fd); fd = -1;
        }
    }
    freeaddrinfo(res);
    JS_FreeCString(ctx, host);
    if (fd < 0) return JS_ThrowInternalError(ctx, "tcp connect failed");
    return JS_NewInt32(ctx, fd);
}

/* socketRead(fd, max) -> string | null (null = EOF) */
static JSValue js_socketread(JSContext *ctx, JSValueConst t,
                             int argc, JSValueConst *argv)
{
    int32_t fd = 0, max = 8192;
    JS_ToInt32(ctx, &fd, argv[0]);
    if (argc > 1) JS_ToInt32(ctx, &max, argv[1]);
    if (max < 1 || max > 262144) max = 8192;
    char *buf = js_malloc(ctx, max);
    if (!buf) return JS_EXCEPTION;
    ssize_t n = read(fd, buf, max);
    if (n == 0) { js_free(ctx, buf); return JS_NULL; }
    if (n < 0)  { js_free(ctx, buf); return JS_ThrowInternalError(ctx, "read err"); }
    JSValue ret = JS_NewStringLen(ctx, buf, (size_t)n);
    js_free(ctx, buf);
    return ret;
}

static JSValue js_socketwrite(JSContext *ctx, JSValueConst t,
                              int argc, JSValueConst *argv)
{
    int32_t fd = 0;
    JS_ToInt32(ctx, &fd, argv[0]);
    size_t len; const char *s = JS_ToCStringLen(ctx, &len, argv[1]);
    if (!s) return JS_EXCEPTION;
    size_t off = 0;
    while (off < len) {
        ssize_t n = write(fd, s + off, len - off);
        if (n <= 0) { JS_FreeCString(ctx, s); return JS_ThrowInternalError(ctx, "write err"); }
        off += n;
    }
    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

static JSValue js_socketclose(JSContext *ctx, JSValueConst t,
                              int argc, JSValueConst *argv)
{
    int32_t fd = 0;
    JS_ToInt32(ctx, &fd, argv[0]);
    close(fd);
    return JS_UNDEFINED;
}

JSValue anclaw_tcp_register(JSContext *ctx, JSValue obj)
{
    (void)ctx;
    static const JSCFunctionListEntry fns[] = {
        JS_CFUNC_DEF("connectTcp", 2, js_connecttcp),
        JS_CFUNC_DEF("socketRead", 2, js_socketread),
        JS_CFUNC_DEF("socketWrite", 2, js_socketwrite),
        JS_CFUNC_DEF("socketClose", 1, js_socketclose),
    };
    JS_SetPropertyFunctionList(ctx, obj, fns, countof(fns));
    return obj;
}
