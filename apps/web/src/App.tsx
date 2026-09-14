import { useEffect, useMemo, useRef, useState } from "react";
import type { Character, ChatMessage, ChatResponse } from "@let-us-talk/shared";
import {
  Avatar,
  ChatContainer,
  Conversation,
  ConversationHeader,
  ConversationList,
  MainContainer,
  Message,
  MessageInput,
  MessageList,
  Sidebar,
  TypingIndicator,
} from "@chatscope/chat-ui-kit-react";

const fallbackCharacters: Character[] = [
  { id: "momo", name: "Momo", avatar: "🌙", tagline: "温柔、细腻，喜欢听你慢慢说", systemPrompt: "" },
  { id: "loki", name: "Loki", avatar: "🦊", tagline: "有点毒舌，但总是站在你这边", systemPrompt: "" },
  { id: "nora", name: "Nora", avatar: "☕", tagline: "理性又好奇，什么都愿意聊", systemPrompt: "" },
];

function avatarSource(character: Character) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="24" fill="#eee5d7"/><text x="48" y="62" text-anchor="middle" font-size="42">${character.avatar}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export function App() {
  const [characters, setCharacters] = useState<Character[]>(fallbackCharacters);
  const [selectedId, setSelectedId] = useState("momo");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => characters.find((character) => character.id === selectedId) ?? fallbackCharacters[0],
    [characters, selectedId],
  );

  useEffect(() => {
    void fetch("/api/characters")
      .then((response) => response.json())
      .then(setCharacters)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setMessages([]);
    setErrorMessage("");
    setLoadingConversation(true);
    let cancelled = false;
    void fetch(`/api/conversations/${selectedId}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("历史消息加载失败");
        return response.json() as Promise<{ messages?: ChatMessage[] }>;
      })
      .then((data) => {
        if (!cancelled) setMessages(data.messages ?? []);
      })
      .catch((error: unknown) => {
        if (!cancelled) setErrorMessage(error instanceof Error ? error.message : "历史消息加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoadingConversation(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  async function sendMessage(value: string) {
    const content = value.trim();
    if (!content || sending) return;

    const requestCharacterId = selectedId;

    setDraft("");
    setErrorMessage("");
    setSending(true);
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, userMessage]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId: requestCharacterId, content }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "请求失败" }));
        throw new Error(error.error ?? "请求失败");
      }
      const data = (await response.json()) as ChatResponse;
      if (selectedIdRef.current !== requestCharacterId) return;
      setMessages((current) => [
        ...current.filter((message) => message.id !== userMessage.id),
        data.userMessage,
        data.assistantMessage,
      ]);
    } catch (error) {
      if (selectedIdRef.current !== requestCharacterId) return;
      setMessages((current) => current.filter((message) => message.id !== userMessage.id));
      setErrorMessage(error instanceof Error ? error.message : "请求失败");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="im-app">
      <MainContainer responsive className="im-container">
        <Sidebar position="left" scrollable className="im-sidebar">
          <div className="im-brand">
            <div className="im-brand-mark">✦</div>
            <div>
              <strong>Let Us Talk</strong>
              <span>AI 朋友</span>
            </div>
          </div>
          <div className="im-section-title">联系人</div>
          <ConversationList>
            {characters.map((character) => (
              <Conversation
                key={character.id}
                name={character.name}
                info={character.tagline}
                active={character.id === selected.id}
                data-character-id={character.id}
                onClick={() => setSelectedId(character.id)}
              >
                <Avatar name={character.name} src={avatarSource(character)} />
              </Conversation>
            ))}
          </ConversationList>
          <div className="im-sidebar-footer">MVP · 私聊实验版</div>
        </Sidebar>

        <ChatContainer className="im-chat-container">
          <ConversationHeader>
            <Avatar name={selected.name} src={avatarSource(selected)} status="available" />
            <ConversationHeader.Content userName={selected.name} info={`AI 角色 · ${selected.tagline}`} />
          </ConversationHeader>

          {errorMessage && <div className="im-error" role="alert">{errorMessage}</div>}

          <MessageList
            autoScrollToBottom
            autoScrollToBottomOnMount
            scrollBehavior="smooth"
            typingIndicator={sending ? <TypingIndicator content={`${selected.name} 正在输入`} /> : undefined}
          >
            {loadingConversation && <div className="im-loading-state">正在加载历史消息…</div>}
            {!loadingConversation && messages.length === 0 && (
              <div className="im-empty-state">
                <img src={avatarSource(selected)} alt="" />
                <strong>开始和 {selected.name} 聊天</strong>
                <span>{selected.tagline}</span>
              </div>
            )}
            {messages.map((message) => (
              <Message
                key={message.id}
                model={{
                  message: message.content || (sending && message.role === "assistant" ? "…" : ""),
                  sentTime: formatTime(message.createdAt),
                  sender: message.role === "assistant" ? selected.name : "我",
                  direction: message.role === "assistant" ? "incoming" : "outgoing",
                  position: "single",
                }}
              />
            ))}
          </MessageList>

          <MessageInput
            value={draft}
            onChange={(_innerHtml, textContent) => setDraft(textContent)}
            onSend={(_innerHtml, textContent) => void sendMessage(textContent)}
            placeholder={`给 ${selected.name} 发消息`}
            sendDisabled={sending || !draft.trim()}
            sendOnReturnDisabled={false}
            attachButton={false}
            autoFocus
          />
        </ChatContainer>
      </MainContainer>
    </div>
  );
}
