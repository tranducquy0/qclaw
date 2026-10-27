/* http.c — in-process libcurl HTTP with a reused easy handle
 * (connection + TLS session reuse: no fork, fast warm requests). */
#include <stdlib.h>
#include <string.h>
#include <curl/curl.h>
#include "common.h"

static CURL *g_curl = NULL;

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
        if (!nb) return 0;
        b->buf = nb; b->cap = cap;
    }
    memcpy(b->buf + b->len, in, n);
    b->len += n;
    b->buf[b->len] = 0;
    return n;
}

/* httpRequest({url, method, headers, body, timeoutMs}) -> {status, body} */
static JSValue js_http(JSContext *ctx, JSValueConst this,
                       int argc, JSValueConst *argv)
{
    if (argc < 1 || !JS_IsObject(argv[0]))
        return JS_ThrowTypeError(ctx, "httpRequest(object) required");
    if (!g_curl && !(g_curl = curl_easy_init()))
        return JS_ThrowInternalError(ctx, "curl init failed");

    JSValue jurl = JS_GetPropertyStr(ctx, argv[0], "url");
    const char *url = JS_ToCString(ctx, jurl);
    JS_FreeValue(ctx, jurl);
    if (!url) return JS_EXCEPTION;

    JSValue jm = JS_GetPropertyStr(ctx, argv[0], "method");
    const char *method = JS_ToCString(ctx, jm);
    JS_FreeValue(ctx, jm);
    if (!method) { JS_FreeCString(ctx, url); return JS_EXCEPTION; }

    JSValue jh = JS_GetPropertyStr(ctx, argv[0], "headers");
    const char *headers = JS_ToCString(ctx, jh);
    JS_FreeValue(ctx, jh);

    JSValue jb = JS_GetPropertyStr(ctx, argv[0], "body");
    const char *body = JS_IsUndefined(jb) || JS_IsNull(jb)
        ? NULL : JS_ToCString(ctx, jb);

    int32_t timeout = 60000;
    JSValue jt = JS_GetPropertyStr(ctx, argv[0], "timeoutMs");
    if (!JS_IsUndefined(jt)) JS_ToInt32(ctx, &timeout, jt);
    JS_FreeValue(ctx, jt);

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
    curl_easy_setopt(g_curl, CURLOPT_HTTPHEADER, NULL);
    return ret;
}

JSValue anclaw_http_register(JSContext *ctx, JSValue obj)
{
    (void)ctx;
    static const JSCFunctionListEntry fns[] = {
        JS_CFUNC_DEF("httpRequest", 1, js_http),
    };
    JS_SetPropertyFunctionList(ctx, obj, fns, countof(fns));
    return obj;
}
