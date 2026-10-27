/* sha256.c — tiny public-domain SHA-256 (no libcrypto dependency).
 * Needed for codex PKCE login on qjs-only hosts (node not installed).
 * Exports: sha256hex(text) -> lowercase hex string.
 */
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include "common.h"

typedef struct {
    uint32_t h[8];
} sha256_state;

static const uint32_t K[64] = {
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,
    0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,
    0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,
    0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,
    0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,
    0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,
    0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,
    0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,
    0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,
    0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,
    0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,
    0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
};

#define ROTR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))
#define CH(x, y, z)  (((x) & (y)) ^ (~(x) & (z)))
#define MAJ(x, y, z) (((x) & (y)) ^ ((x) & (z)) ^ ((y) & (z)))
#define S0(x) (ROTR(x, 2) ^ ROTR(x, 13) ^ ROTR(x, 22))
#define S1(x) (ROTR(x, 6) ^ ROTR(x, 11) ^ ROTR(x, 25))
#define s0(x) (ROTR(x, 7) ^ ROTR(x, 18) ^ ((x) >> 3))
#define s1(x) (ROTR(x, 17) ^ ROTR(x, 19) ^ ((x) >> 10))

static void sha256_block(sha256_state *st, const uint8_t *p)
{
    uint32_t w[64];
    for (int i = 0; i < 16; i++) {
        w[i] = ((uint32_t)p[i*4] << 24) | ((uint32_t)p[i*4+1] << 16) |
               ((uint32_t)p[i*4+2] << 8) | (uint32_t)p[i*4+3];
    }
    for (int i = 16; i < 64; i++)
        w[i] = s1(w[i-2]) + w[i-7] + s0(w[i-15]) + w[i-16];

    uint32_t a = st->h[0], b = st->h[1], c = st->h[2], d = st->h[3];
    uint32_t e = st->h[4], f = st->h[5], g = st->h[6], hh = st->h[7];
    for (int i = 0; i < 64; i++) {
        uint32_t t1 = hh + S1(e) + CH(e, f, g) + K[i] + w[i];
        uint32_t t2 = S0(a) + MAJ(a, b, c);
        hh = g; g = f; f = e; e = d + t1;
        d = c; c = b; b = a; a = t1 + t2;
    }
    st->h[0] += a; st->h[1] += b; st->h[2] += c; st->h[3] += d;
    st->h[4] += e; st->h[5] += f; st->h[6] += g; st->h[7] += hh;
}

static void sha256(const uint8_t *msg, size_t len, uint8_t out[32])
{
    static const uint32_t H0[8] = {
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    };
    sha256_state st;
    for (int i = 0; i < 8; i++) st.h[i] = H0[i];

    /* full blocks */
    size_t i = 0;
    for (; i + 64 <= len; i += 64)
        sha256_block(&st, msg + i);

    /* final block with padding */
    uint8_t tail[128];
    size_t rem = len - i;
    memcpy(tail, msg + i, rem);
    tail[rem] = 0x80;
    size_t plen = rem + 1;
    while (plen % 64 != 56) tail[plen++] = 0;
    uint64_t bits = (uint64_t)len * 8;
    for (int k = 0; k < 8; k++)
        tail[plen++] = (uint8_t)(bits >> (56 - k * 8));
    sha256_block(&st, tail);
    if (plen > 64)
        sha256_block(&st, tail + 64);

    for (int k = 0; k < 8; k++) {
        out[k*4+0] = (uint8_t)(st.h[k] >> 24);
        out[k*4+1] = (uint8_t)(st.h[k] >> 16);
        out[k*4+2] = (uint8_t)(st.h[k] >> 8);
        out[k*4+3] = (uint8_t)(st.h[k]);
    }
}

/* sha256hex(text) -> hex */
static JSValue js_sha256hex(JSContext *ctx, JSValueConst t,
                            int argc, JSValueConst *argv)
{
    size_t len; const char *s = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!s) return JS_EXCEPTION;
    uint8_t digest[32];
    sha256((const uint8_t *)s, len, digest);
    JS_FreeCString(ctx, s);

    char hex[65];
    static const char *HX = "0123456789abcdef";
    for (int i = 0; i < 32; i++) {
        hex[i*2] = HX[digest[i] >> 4];
        hex[i*2+1] = HX[digest[i] & 15];
    }
    hex[64] = 0;
    return JS_NewStringLen(ctx, hex, 64);
}

int anclaw_sha256_register(JSContext *ctx, JSValue obj)
{
    static const JSCFunctionListEntry fns[] = {
        JS_CFUNC_DEF("sha256hex", 1, js_sha256hex),
    };
    JS_SetPropertyFunctionList(ctx, obj, fns, countof(fns));
    return 0;
}
