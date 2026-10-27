/* anclaw_net.c — quickjs-ng native module for anclaw.
 *
 * Exports:
 *   httpRequest({url, method, headers, body, timeoutMs}) -> {status, body}
 *       In-process libcurl with a reused easy handle: no fork, TLS session
 *       reuse. headers is a string with "Name: value" lines separated by \n.
 *   connectTcp(host, port) -> fd            (raw socket, IRC phase 3)
 *   socketRead(fd, max) -> string | null    (null = EOF)
 *   socketWrite(fd, str) -> void
 *   socketClose(fd) -> void
 *
 * Build (termux): cc/native/build.sh
 */
#include <stdlib.h>
#include <string.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#include <curl/curl.h>
#include <quickjs.h>

#define countof(x) (sizeof(x) / sizeof((x)[0]))

static CURL *g_curl = NULL;

/* ---- write callback: accumulate body ------------------------------------ */
typedef struct {
    char *buf;
    size_t len, cap;
} BodyBuf;

static size_t write_cb(char *in, size_t size, size_t nmemb, void *ud)
{
    BodyBuf *b = ud;
    size_t n = size * nmemb;
    if (b->len + n + 1 > b->cap) {
        size_t cap = b->cap ? b->cap : 8192;
        while (cap < b->len + n + 1) cap *= 2;
        char *nb = realloc(b->buf, cap);
        if (!nb) return 0;      /* signals curl to abort */
        b->buf = nb; b->cap = cap;
    }
    memcpy(b->buf + b->len, in, n);
    b->len += n;
    b->buf[b->len] = 0;
    return n;
}

/* ---- httpRequest ---------------------------------------------------------- */
static JSValue js_http(JSContext *ctx, JSValueConst this,
                       int argc, JSValueConst *argv)
{
    if (argc < 1 || !JS_IsObject(argv[0]))
        return JS_ThrowTypeError(ctx, "httpRequest(object) required");
    if (!g_curl && !(g_curl = curl_easy_init()))
        return JS_ThrowInternalError(ctx, "curl init failed");

    /* url */
    JSValue jurl = JS_GetPropertyStr(ctx, argv[0], "url");
    const char *url = JS_ToCString(ctx, jurl);
    JS_FreeValue(ctx, jurl);
    if (!url) return JS_EXCEPTION;

    /* method */
    JSValue jm = JS_GetPropertyStr(ctx, argv[0], "method");
    const char *method = JS_ToCString(ctx, jm);
    JS_FreeValue(ctx, jm);
    if (!method) { JS_FreeCString(ctx, url); return JS_EXCEPTION; }

    /* headers: "Name: v\n..." */
    JSValue jh = JS_GetPropertyStr(ctx, argv[0], "headers");
    const char *headers = JS_ToCString(ctx, jh);
    JS_FreeValue(ctx, jh);

    /* body */
    JSValue jb = JS_GetPropertyStr(ctx, argv[0], "body");
    const char *body = JS_IsUndefined(jb) || JS_IsNull(jb)
        ? NULL : JS_ToCString(ctx, jb);

    /* timeout */
    int32_t timeout = 60000;
    JSValue jt = JS_GetPropertyStr(ctx, argv[0], "timeoutMs");
    if (!JS_IsUndefined(jt)) JS_ToInt32(ctx, &timeout, jt);
    JS_FreeValue(ctx, jt);

    /* headers list */
    struct curl_slist *hl = NULL;
    if (headers && *headers) {
        const char *p = headers;
        while (*p) {
            const char *e = strchr(p, '\n');
            size_t len = e ? (size_t)(e - p) : strlen(p);
            if (len) {
                char *line = malloc(len + 1);
                memcpy(line, p, len); line[len] = 0;
                hl = curl_slist_append(hl, line);
                free(line);
            }
            p = e ? e + 1 : p + len;
        }
    }

    BodyBuf bb = {0};
    curl_easy_setopt(g_curl, CURLOPT_URL, url);
    curl_easy_setopt(g_curl, CURLOPT_TIMEOUT_MS, (long)timeout);
    curl_easy_setopt(g_curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(g_curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(g_curl, CURLOPT_MAXREDIRS, 5L);
    curl_easy_setopt(g_curl, CURLOPT_WRITEFUNCTION, write_cb);
    curl_easy_setopt(g_curl, CURLOPT_WRITEDATA, &bb);
    curl_easy_setopt(g_curl, CURLOPT_HTTPHEADER, hl);
    curl_easy_setopt(g_curl, CURLOPT_USERAGENT, "anclaw/0.1");

    if (!strcmp(method, "POST") || !strcmp(method, "PUT") ||
        !strcmp(method, "PATCH") || !strcmp(method, "DELETE")) {
        curl_easy_setopt(g_curl, CURLOPT_CUSTOMREQUEST, method);
        curl_easy_setopt(g_curl, CURLOPT_POSTFIELDS, body ? body : "");
        curl_easy_setopt(g_curl, CURLOPT_POSTFIELDSIZE,
                         body ? (long)strlen(body) : 0L);
    } else {
        curl_easy_setopt(g_curl, CURLOPT_CUSTOMREQUEST, NULL);
        curl_easy_setopt(g_curl, CURLOPT_HTTPGET, 1L);
    }

    CURLcode rc = curl_easy_perform(g_curl);

    JSValue ret = JS_UNDEFINED;
    if (rc != CURLE_OK) {
        JS_ThrowInternalError(ctx, "http: %s", curl_easy_strerror(rc));
        ret = JS_EXCEPTION;
    } else {
        long status = 0;
        curl_easy_getinfo(g_curl, CURLINFO_RESPONSE_CODE, &status);
        ret = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, ret, "status", JS_NewInt32(ctx, (int)status));
        JS_SetPropertyStr(ctx, ret, "body",
            JS_NewStringLen(ctx, bb.buf ? bb.buf : "", bb.len));
    }

    free(bb.buf);
    if (hl) curl_slist_free_all(hl);
    if (body) JS_FreeCString(ctx, body);
    if (headers) JS_FreeCString(ctx, headers);
    JS_FreeCString(ctx, url);
    curl_easy_setopt(g_curl, CURLOPT_HTTPHEADER, NULL); /* detach before free */
    return ret;
}

/* ---- tcp for IRC ---------------------------------------------------------- */
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
    if (n == 0) { js_free(ctx, buf); return JS_NULL; /* EOF */ }
    if (n < 0)  { js_free(ctx, buf); return JS_ThrowInternalError(ctx, "read err"); }
    /* wire protocol: \n-delimited utf-8 — bin-safe pass-through as string */
    JSValue ret = JS_NewStringLen(ctx, buf, n);
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

/* ---- module ---------------------------------------------------------------- */
static const JSCFunctionListEntry fns[] = {
    JS_CFUNC_DEF("httpRequest", 1, js_http),
    JS_CFUNC_DEF("connectTcp", 2, js_connecttcp),
    JS_CFUNC_DEF("socketRead", 2, js_socketread),
    JS_CFUNC_DEF("socketWrite", 2, js_socketwrite),
    JS_CFUNC_DEF("socketClose", 1, js_socketclose),
};

static int anclaw_net_init(JSContext *ctx, JSModuleDef *m)
{
    curl_global_init(CURL_GLOBAL_ALL);
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, obj, fns, countof(fns));
    JS_SetModuleExport(ctx, m, "default", obj);
    return 0;
}

JS_MODULE_EXTERN JSModuleDef *js_init_module(JSContext *ctx, const char *name)
{
    JSModuleDef *m = JS_NewCModule(ctx, name, anclaw_net_init);
    if (!m) return NULL;
    JS_AddModuleExport(ctx, m, "default");
    return m;
}
