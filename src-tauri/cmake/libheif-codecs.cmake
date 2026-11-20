# Toolchain do cmake da libheif embutida (libheif-sys), aplicado via .cargo/config.toml.
# O build.rs do libheif-sys força WITH_<codec>=ON para todos os codecs: o resultado
# dependeria dos -dev presentes na máquina. Aqui só o AOM (AVIF) pode ser encontrado;
# o HEIC (libde265) é carregado com dlopen por native/heic, fora da libheif.
foreach(pkg IN ITEMS
    LIBDE265 X265 kvazaar UVG266 vvdec vvenc X264 OpenH264 DAV1D SvtEnc RAV1E
    JPEG OpenJPEG OPENJPH FFMPEG libsharpyuv Brotli)
  set(CMAKE_DISABLE_FIND_PACKAGE_${pkg} ON CACHE BOOL "" FORCE)
endforeach()
