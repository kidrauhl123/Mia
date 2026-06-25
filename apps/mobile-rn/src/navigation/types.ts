export type MessagesStackParamList = {
  Conversations: undefined;
  Chat: { conversationId: string; title: string };
  GroupDetail: { conversationId: string; title: string };
  BotSessions: { conversationId: string; title: string };
};

export type ContactsStackParamList = {
  ContactsHome: undefined;
  BotDetail: { botId: string; title: string };
};
