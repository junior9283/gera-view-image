// Codificador HEIC opcional: o plugin kvazaar da própria libheif (encoder_kvazaar.cc, compilado
// junto pelo build.rs) chama só `kvz_api_get`, definida aqui e repassada para a libkvazaar
// carregada com dlopen. Assim o binário não tem libkvazaar como NEEDED: sem ela o app inicia e
// gravar HEIC fica indisponível (o Exportar oculta o formato).
//
// ABI: include/kvazaar.h é o da 2.3.2 (soname 7). Da 2.2 (também soname 7) para a 2.3 só entrou
// `enable_logging_output`, no FIM do kvz_config; por isso o build.rs NÃO define
// HAVE_KVAZAAR_ENABLE_LOGGING (escrever esse campo numa 2.2 passaria do fim da struct).
#include <dlfcn.h>

extern "C" {
#include <kvazaar.h>
}

#include "libheif/heif_plugin.h"
#include "plugins/encoder_kvazaar.h"

namespace {
const kvz_api* (*p_kvz_api_get)(int) = nullptr;
}

extern "C" {
const kvz_api* kvz_api_get(int bit_depth) { return p_kvz_api_get ? p_kvz_api_get(bit_depth) : nullptr; }

// 1 se `soname` abriu e entrega a API de 8 bits. Chamar uma vez, antes de registrar o plugin.
int gvi_kvazaar_load(const char* soname) {
  void* h = dlopen(soname, RTLD_NOW | RTLD_LOCAL);
  if (!h) return 0;
  p_kvz_api_get = reinterpret_cast<decltype(p_kvz_api_get)>(dlsym(h, "kvz_api_get"));
  if (p_kvz_api_get && p_kvz_api_get(8)) return 1;
  p_kvz_api_get = nullptr;
  dlclose(h);
  return 0;
}

const heif_encoder_plugin* gvi_kvazaar_plugin(void) { return get_encoder_plugin_kvazaar(); }
}
