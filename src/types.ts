export type Language = "en" | "es";

export type User = {
  id: string;
  email: string;
};

export type EventSummary = {
  id: string;
  slug: string;
  title: string;
  dateLabel: string;
  locationLabel: string;
  language: Language;
  isPublished: boolean;
  isArchived: boolean;
  updatedAt: string;
};

export type EventDetail = EventSummary & {
  introText: string;
  askButtonLabel: string;
  footerLabel: string;
  footerUrl: string;
  accentColor: string;
};

export type Talk = {
  id: string;
  title: string;
  speakers: string;
  role: string;
  position: number;
};

export type PublicEvent = EventDetail & {
  talks: Talk[];
};

export type QuestionStatus = "open" | "answered" | "hidden";

export type Question = {
  id: string;
  eventId: string;
  talkId: string | null;
  body: string;
  authorName: string | null;
  status: QuestionStatus;
  pinned: boolean;
  createdAt: string;
  talkTitle: string | null;
  talkSpeakers: string | null;
  score: number;
  userVote?: number;
};

export type OwnerEventPayload = {
  title: string;
  slug: string;
  dateLabel: string;
  locationLabel: string;
  language: Language;
  introText: string;
  askButtonLabel: string;
  footerLabel: string;
  footerUrl: string;
  accentColor: string;
  isPublished: boolean;
  isArchived: boolean;
};
