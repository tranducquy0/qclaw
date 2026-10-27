/* common.h — shared decls for anclaw native modules. */
#ifndef ANCLAW_COMMON_H
#define ANCLAW_COMMON_H

#include <quickjs.h>

#define countof(x) (sizeof(x) / sizeof((x)[0]))

/* each submodule registers its functions into `obj` (a JS namespace object);
   a submodule may set a flag in `g` to mark itself unavailable. */
JSValue anclaw_http_register(JSContext *ctx, JSValue obj);   /* http.c  */
JSValue anclaw_tcp_register(JSContext *ctx, JSValue obj);    /* tcp.c   */
int anclaw_sha256_register(JSContext *ctx, JSValue obj);     /* sha256.c: returns 0 ok */

#endif
