import i18n from "./i18n";

// jsdom reporta en-US; os testes de interface assertam os textos em pt-BR.
await i18n.changeLanguage("pt-BR");
