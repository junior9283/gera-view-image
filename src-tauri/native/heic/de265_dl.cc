// Decodificador HEIC opcional: o plugin libde265 da própria libheif (decoder_libde265.cc,
// compilado junto pelo build.rs) chama as funções `de265_*` definidas aqui, que repassam
// para a libde265 carregada com dlopen. Assim o binário não tem libde265 como NEEDED:
// sem ela o app inicia, e só abrir HEIC falha (`heic_decoder_missing`).
#include <dlfcn.h>

#include <libde265/de265.h>

#include "libheif/heif_plugin.h"
#include "plugins/decoder_libde265.h"

// (retorno, nome, parâmetros, argumentos): exatamente as funções que o plugin usa.
#define GVI_DE265_FUNCS(X)                                                                   \
  X(de265_error, de265_decode, (de265_decoder_context * c, int* more), (c, more))            \
  X(de265_error, de265_flush_data, (de265_decoder_context * c), (c))                         \
  X(de265_error, de265_free, (void), ())                                                     \
  X(de265_error, de265_free_decoder, (de265_decoder_context * c), (c))                       \
  X(int, de265_get_bits_per_pixel, (const de265_image* i, int ch), (i, ch))                  \
  X(de265_chroma, de265_get_chroma_format, (const de265_image* i), (i))                      \
  X(int, de265_get_image_colour_primaries, (const de265_image* i), (i))                      \
  X(int, de265_get_image_full_range_flag, (const de265_image* i), (i))                       \
  X(int, de265_get_image_height, (const de265_image* i, int ch), (i, ch))                    \
  X(int, de265_get_image_matrix_coefficients, (const de265_image* i), (i))                   \
  X(const uint8_t*, de265_get_image_plane, (const de265_image* i, int ch, int* stride),      \
    (i, ch, stride))                                                                         \
  X(int, de265_get_image_transfer_characteristics, (const de265_image* i), (i))              \
  X(void*, de265_get_image_user_data, (const de265_image* i), (i))                           \
  X(int, de265_get_image_width, (const de265_image* i, int ch), (i, ch))                     \
  X(const de265_image*, de265_get_next_picture, (de265_decoder_context * c), (c))            \
  X(const char*, de265_get_version, (void), ())                                              \
  X(de265_error, de265_init, (void), ())                                                     \
  X(de265_decoder_context*, de265_new_decoder, (void), ())                                   \
  X(de265_error, de265_push_NAL,                                                             \
    (de265_decoder_context * c, const void* d, int n, de265_PTS pts, void* u),               \
    (c, d, n, pts, u))                                                                       \
  X(void, de265_release_next_picture, (de265_decoder_context * c), (c))                      \
  X(de265_error, de265_start_worker_threads, (de265_decoder_context * c, int n), (c, n))

namespace {
#define GVI_PTR(ret, name, params, args) ret(*p_##name) params = nullptr;
GVI_DE265_FUNCS(GVI_PTR)
#undef GVI_PTR
}  // namespace

extern "C" {
#define GVI_FWD(ret, name, params, args) \
  ret name params { return p_##name args; }
GVI_DE265_FUNCS(GVI_FWD)
#undef GVI_FWD

// 1 se `soname` abriu e tem todas as funções. Chamar uma vez, antes de registrar o plugin.
int gvi_de265_load(const char* soname) {
  void* h = dlopen(soname, RTLD_NOW | RTLD_LOCAL);
  if (!h) return 0;
  bool ok = true;
#define GVI_LOAD(ret, name, params, args)                          \
  p_##name = reinterpret_cast<decltype(p_##name)>(dlsym(h, #name)); \
  ok = ok && p_##name;
  GVI_DE265_FUNCS(GVI_LOAD)
#undef GVI_LOAD
  if (ok) return 1;
  // Lib incompleta: nenhum ponteiro pode sobrar apontando para a lib descarregada.
#define GVI_RESET(ret, name, params, args) p_##name = nullptr;
  GVI_DE265_FUNCS(GVI_RESET)
#undef GVI_RESET
  dlclose(h);
  return 0;
}

const heif_decoder_plugin* gvi_de265_plugin(void) { return get_decoder_plugin_libde265(); }
}
