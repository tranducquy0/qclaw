/* module.c — anclaw native module entry: bundle + register all
 * submodules (see native_modules/common.h). Exports:
 *   default: { httpRequest, connectTcp, socketRead, socketWrite,
 *              socketClose, sha256hex }
 * Build: src/native_modules/build.sh (see README there).
 */
#include <curl/curl.h>
#include "common.h"

static int anclaw_init(JSContext *ctx, JSModuleDef *m)
{
    curl_global_init(CURL_GLOBAL_ALL);
    JSValue obj = JS_NewObject(ctx);

    anclaw_http_register(ctx, obj);
    anclaw_tcp_register(ctx, obj);
    anclaw_sha256_register(ctx, obj);

    JS_SetModuleExport(ctx, m, "default", obj);
    return 0;
}

JS_MODULE_EXTERN JSModuleDef *js_init_module(JSContext *ctx, const char *name)
{
    JSModuleDef *m = JS_NewCModule(ctx, name, anclaw_init);
    if (!m) return NULL;
    JS_AddModuleExport(ctx, m, "default");
    return m;
}
