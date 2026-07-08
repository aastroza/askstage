import type { Language } from "./types";

export const copy = {
  en: {
    askQuestion: "Ask a question",
    askQuestionShort: "Ask",
    close: "Close",
    allTalks: "All",
    allTalksCount: "talks",
    open: "Open",
    answered: "Answered",
    all: "All",
    loading: "Loading questions...",
    empty: "Be the first person to ask.",
    question: "Your question",
    questionPlaceholder: "What would you like to ask the speakers?",
    nameOptional: "Name (optional)",
    namePlaceholder: "Your name",
    send: "Send question",
    talk: "Talk",
    anonymous: "Anonymous",
    defaultIntro: "Choose a talk, write your question, and vote for the ones you want answered live.",
    defaultFooter: "Create your own live Q&A",
    publicFooterUrl: "askstage.com",
  },
  es: {
    askQuestion: "Hacer una pregunta",
    askQuestionShort: "Preguntar",
    close: "Cerrar",
    allTalks: "Todas",
    allTalksCount: "charlas",
    open: "Por responder",
    answered: "Respondidas",
    all: "Todas",
    loading: "Cargando preguntas...",
    empty: "Se la primera persona en preguntar.",
    question: "Tu pregunta",
    questionPlaceholder: "\u00bfQue te gustaria preguntarle a los speakers?",
    nameOptional: "Nombre (opcional)",
    namePlaceholder: "Tu nombre",
    send: "Enviar pregunta",
    talk: "Charla",
    anonymous: "Anonima",
    defaultIntro: "Elige la charla, escribe tu pregunta y vota las que quieres escuchar en vivo.",
    defaultFooter: "Crea tu propio Q&A en vivo",
    publicFooterUrl: "askstage.com",
  },
} satisfies Record<Language, Record<string, string>>;

export function eventCopy(language: Language) {
  return copy[language] ?? copy.en;
}
