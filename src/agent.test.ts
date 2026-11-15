import { afterEach, describe, expect, it, vi } from "vitest"
import {
  buildChatRequestBody,
  detectLanguageModelAvailability,
  emptyLlmSelection,
  emptyLlmSettings,
  extractChatReply,
  extractModelNames,
  extractStreamReply,
  filterAndSortModelNames,
  parseExtraArgs,
  parseModelList,
  parseModelOptions,
  parseThinkingLevels,
  parseThinkingValue,
  resolveAllProviderModelOptions,
  resolveModelOptions,
  runEditorChatTurn,
  streamChatParts,
  streamToolCallParts,
  testLlmConnection,
} from "./agent"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("extractModelNames", () => {
  it("extrahiert Modellnamen aus einer OpenAI-Modellliste", () => {
    const models = extractModelNames({
      object: "list",
      data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }, { id: "o3-mini" }],
    })
    expect(models).toEqual(["gpt-4o", "gpt-4o-mini", "o3-mini"])
  })

  it("überspringt ungültige oder leere Einträge im data-Array", () => {
    const models = extractModelNames({
      data: [{ id: "gpt-4o" }, { id: "" }, { id: "   " }, { name: "ohne-id" }, null],
    })
    expect(models).toEqual(["gpt-4o"])
  })

  it("wirft bei fehlendem data-Array", () => {
    expect(() => extractModelNames({ models: [] })).toThrow(
      "Unerwartete Antwort: keine Modellliste",
    )
    expect(() => extractModelNames(null)).toThrow("Unerwartete Antwort: keine Modellliste")
  })
})

describe("extractChatReply", () => {
  it("extrahiert den Antworttext aus choices[0].message.content", () => {
    const reply = extractChatReply({
      id: "chatcmpl-1",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
    })
    expect(reply).toBe("ok")
  })

  it("akzeptiert content-Arrays und choices[0].text", () => {
    expect(
      extractChatReply({
        choices: [{ message: { content: [{ type: "text", text: "ok" }] } }],
      }),
    ).toBe("ok")
    expect(extractChatReply({ choices: [{ text: "ok" }] })).toBe("ok")
  })

  it("greift auf verschiedene Reasoning-Felder zurück, wenn content leer oder null ist", () => {
    expect(
      extractChatReply({
        choices: [{ message: { content: "", reasoning_content: "Denke nach..." } }],
      }),
    ).toBe("Denke nach...")
    expect(
      extractChatReply({
        choices: [{ message: { content: null, reasoning: "Kurzer Gedanke" } }],
      }),
    ).toBe("Kurzer Gedanke")
    expect(
      extractChatReply({
        choices: [{ message: { thinking: "Thinking..." } }],
      }),
    ).toBe("Thinking...")
    expect(
      extractChatReply({
        choices: [{ message: { content: "", reasoning_details: [{ text: "Detail" }] } }],
      }),
    ).toBe("Detail")
  })

  it("bevorzugt nicht-leeren content gegenüber Reasoning", () => {
    expect(
      extractChatReply({
        choices: [{ message: { content: "ok", reasoning_content: "Denke nach" } }],
      }),
    ).toBe("ok")
  })

  it("wirft bei fehlenden oder leeren choices", () => {
    expect(() => extractChatReply({ choices: [] })).toThrow("Unerwartete Antwort: keine choices")
    expect(() => extractChatReply({})).toThrow("Unerwartete Antwort: keine choices")
  })

  it("wirft bei fehlender Nachricht oder fehlendem content", () => {
    expect(() => extractChatReply({ choices: [{ message: {} }] })).toThrow(
      "Unerwartete Antwort: keine Nachricht",
    )
    expect(() => extractChatReply({ choices: [{}] })).toThrow(
      "Unerwartete Antwort: keine Nachricht",
    )
  })
})

describe("extractStreamReply", () => {
  it("setzt den Antworttext aus SSE-Chunks zusammen und ignoriert [DONE]", () => {
    const sse = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":"o"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":"k"}}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n")

    expect(extractStreamReply(sse)).toBe("ok")
  })

  it("bevorzugt content gegenüber Reasoning im Stream und fällt bei leerem content auf Reasoning zurück", () => {
    const sseWithBoth = [
      'data: {"choices":[{"delta":{"reasoning_content":"Denke..."}}]}',
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      "data: [DONE]",
    ].join("\n")
    expect(extractStreamReply(sseWithBoth)).toBe("ok")

    const sseReasoningOnly = [
      'data: {"choices":[{"delta":{"reasoning":"Erster "}}]}',
      'data: {"choices":[{"delta":{"thinking":"Gedanke"}}]}',
      "data: [DONE]",
    ].join("\n")
    expect(extractStreamReply(sseReasoningOnly)).toBe("Erster Gedanke")
  })

  it("wirft bei fehlenden SSE-Daten", () => {
    expect(() => extractStreamReply('{"choices":[]}')).toThrow(
      "Unerwartete Streaming-Antwort: keine Daten",
    )
  })

  it("wirft bei ungültigem JSON im Chunk", () => {
    expect(() => extractStreamReply("data: {kaputt")).toThrow(
      "Streaming-Chunk ist kein gültiges JSON",
    )
  })

  it("wirft bei Fehlerobjekt im Chunk", () => {
    expect(() => extractStreamReply('data: {"error":{"message":"Quota exceeded"}}')).toThrow(
      "Fehlerantwort: Quota exceeded",
    )
  })
})

describe("parseExtraArgs & buildChatRequestBody", () => {
  it("parst leere oder gültige JSON-Objekte und wirft bei ungültigen Werten", () => {
    expect(parseExtraArgs("")).toEqual({})
    expect(parseExtraArgs("   ")).toEqual({})
    expect(parseExtraArgs('{"temperature": 0.2, "max_tokens": 64}')).toEqual({
      temperature: 0.2,
      max_tokens: 64,
    })
    expect(() => parseExtraArgs("{kaputt")).toThrow("Zusätzliche Parameter sind kein gültiges JSON")
    expect(() => parseExtraArgs("[1, 2]")).toThrow(
      "Zusätzliche Parameter müssen ein JSON-Objekt sein",
    )
  })

  it("parst Thinking-Level und konvertiert Booleans/Zahlen/JSON für den Request-Body", () => {
    expect(parseModelList(" gpt-4o, Schnell=gpt-4o-mini, gpt-4o , ")).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
    ])
    expect(parseModelOptions(" gpt-4o, Schnell=gpt-4o-mini, Dup=gpt-4o-mini , ")).toEqual([
      { label: "gpt-4o", value: "gpt-4o" },
      { label: "Schnell", value: "gpt-4o-mini" },
    ])
    expect(parseThinkingLevels(" Aus=none, low, low , Hoch=high, ")).toEqual([
      { label: "Aus", value: "none" },
      { label: "low", value: "low" },
      { label: "Hoch", value: "high" },
    ])
    expect(parseThinkingValue("true")).toBe(true)
    expect(parseThinkingValue("false")).toBe(false)
    expect(parseThinkingValue("1024")).toBe(1024)
    expect(parseThinkingValue("medium")).toBe("medium")

    expect(
      buildChatRequestBody(
        {
          ...emptyLlmSettings,
          ...emptyLlmSelection,
          model: "qwen3",
          thinkingParam: "chat_template_kwargs.enable_thinking",
          thinkingLevels: "false, true",
          thinkingLevel: "false",
          extraArgs: '{"chat_template_kwargs": {"add_generation_prompt": true}}',
        },
        "Hi",
      ),
    ).toEqual({
      model: "qwen3",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 500,
      stream: true,
      chat_template_kwargs: {
        add_generation_prompt: true,
        enable_thinking: false,
      },
    })
  })

  it("fügt reasoning_effort nur bei gesetztem thinkingLevel hinzu und übernimmt extraArgs", () => {
    expect(
      buildChatRequestBody(
        { ...emptyLlmSettings, ...emptyLlmSelection, model: "gpt-4o-mini" },
        "Hi",
      ),
    ).not.toHaveProperty("reasoning_effort")

    expect(
      buildChatRequestBody(
        {
          ...emptyLlmSettings,
          ...emptyLlmSelection,
          model: "gpt-4o-mini",
          thinkingParam: "reasoning_effort",
          thinkingLevel: "low",
          extraArgs: '{"temperature": 0.2, "max_tokens": 64}',
        },
        "Hi",
      ),
    ).toEqual({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 64,
      stream: true,
      reasoning_effort: "low",
      temperature: 0.2,
    })
  })
})

describe("testLlmConnection", () => {
  it("hat streaming und toolCalls standardmäßig aktiviert und kein Thinking vorkonfiguriert", () => {
    expect(emptyLlmSettings.enabled).toBe(false)
    expect(emptyLlmSettings.streaming).toBe(true)
    expect(emptyLlmSettings.toolCalls).toBe(true)
    expect(emptyLlmSettings.thinkingParam).toBe("")
    expect(emptyLlmSettings.thinkingLevels).toBe("")
    expect(emptyLlmSettings.extraArgs).toBe("")
    expect(emptyLlmSelection.model).toBe("")
    expect(emptyLlmSelection.thinkingLevel).toBe("")
  })

  it("zeigt ohne Modell die Anzahl und ersten Modellnamen an", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                { id: "gpt-4o" },
                { id: "gpt-4o-mini" },
                { id: "o3-mini" },
                { id: "claude-3.5" },
              ],
            }),
            { status: 200 },
          ),
      ),
    )

    const result = await testLlmConnection({
      ...emptyLlmSettings,
      ...emptyLlmSelection,
      baseUrl: "https://api.example.com/v1/",
      apiKey: "sk-test",
      model: "",
      streaming: false,
    })

    expect(result).toEqual({
      content: "",
      reasoning: "",
      models: ["claude-3.5", "gpt-4o", "gpt-4o-mini", "o3-mini"],
    })
  })

  it("fragt nicht /models ab, wenn oben manuelle Modelle angegeben sind", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
          }),
          { status: 200 },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)

    const result = await testLlmConnection({
      ...emptyLlmSettings,
      ...emptyLlmSelection,
      baseUrl: "https://api.example.com/v1",
      models: "gpt-4o, gpt-4o-mini",
      model: "",
      streaming: false,
    })

    expect(result).toEqual({ content: "ok", reasoning: "", models: [] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.example.com/v1/chat/completions")
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "gpt-4o",
    })
  })

  it("zeigt mit Modell die extrahierte Chat-Antwort an", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
          }),
          { status: 200 },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)

    const result = await testLlmConnection({
      ...emptyLlmSettings,
      ...emptyLlmSelection,
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      model: " gpt-4o-mini ",
      streaming: false,
    })

    expect(result).toEqual({ content: "ok", reasoning: "", models: [] })
    const init = fetchMock.mock.calls[0]?.[1]
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "gpt-4o-mini",
      stream: false,
    })
  })

  it("sendet bei aktiviertem Streaming stream: true und zeigt die gestreamte Antwort an", async () => {
    const sse = ['data: {"choices":[{"delta":{"content":"ok"}}]}', "data: [DONE]"].join("\n")

    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const result = await testLlmConnection({
      ...emptyLlmSettings,
      ...emptyLlmSelection,
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      streaming: true,
    })

    expect(result).toEqual({ content: "ok", reasoning: "", models: [] })
    const init = fetchMock.mock.calls[0]?.[1]
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "gpt-4o-mini",
      stream: true,
    })
  })

  it("wirft bei leerer Chat-Antwort", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { role: "assistant", content: "   " } }],
            }),
            { status: 200 },
          ),
      ),
    )

    await expect(
      testLlmConnection({
        ...emptyLlmSettings,
        ...emptyLlmSelection,
        baseUrl: "https://api.example.com/v1",
        apiKey: "",
        model: "gpt-4o-mini",
        streaming: false,
      }),
    ).rejects.toThrow("Unerwartete Antwort: leere Chat-Antwort")
  })
})

describe("streamChatParts", () => {
  it("liefert Reasoning und Antworttext inkrementell pro SSE-Chunk", async () => {
    const encoder = new TextEncoder()
    const chunks = [
      encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"Denke "}}]}\n\n'),
      encoder.encode('data: {"choices":[{"delta":{"content":"Ha'),
      encoder.encode('llo"}}]}\n\n'),
      encoder.encode('data: {"choices":[{"delta":{"content":" Welt"}}]}\n\n'),
      encoder.encode("data: [DONE]\n\n"),
    ]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(chunk))
        controller.close()
      },
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 200 })),
    )

    const updates: Array<{ content: string; reasoning: string }> = []
    const result = await streamChatParts(
      {
        ...emptyLlmSettings,
        ...emptyLlmSelection,
        baseUrl: "https://api.example.com/v1",
        model: "gpt-4o-mini",
        streaming: true,
      },
      "Hallo",
      (parts) => {
        updates.push(parts)
      },
    )

    expect(updates).toEqual([
      { content: "", reasoning: "Denke " },
      { content: "Hallo", reasoning: "Denke " },
      { content: "Hallo Welt", reasoning: "Denke " },
    ])
    expect(result).toEqual({ content: "Hallo Welt", reasoning: "Denke " })
  })
})

describe("testLlmConnection mit Modus", () => {
  it("fragt bei Modus 'models' immer /models ab, auch wenn manuelle Modelle gesetzt sind", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: [{ id: "llama-3.3" }, { id: "qwen3" }] }), {
          status: 200,
        }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const result = await testLlmConnection(
      {
        ...emptyLlmSettings,
        ...emptyLlmSelection,
        baseUrl: "https://api.example.com/v1",
        models: "manuelles-modell",
        model: "manuelles-modell",
      },
      "models",
    )

    expect(result).toEqual({
      content: "",
      reasoning: "",
      models: ["llama-3.3", "qwen3"],
    })
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.example.com/v1/models")
  })

  it("testet bei Modus 'tools' einen Tool-Aufruf über /chat/completions", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: { name: "ping_test", arguments: '{"token":"ok"}' },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)

    const result = await testLlmConnection(
      {
        ...emptyLlmSettings,
        ...emptyLlmSelection,
        baseUrl: "https://api.example.com/v1",
        model: "gpt-4o-mini",
      },
      "tools",
    )

    expect(result).toEqual({
      content: 'Tool-Aufruf: ping_test({"token":"ok"})',
      reasoning: "",
      models: [],
    })
    const init = fetchMock.mock.calls[0]?.[1]
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "gpt-4o-mini",
      stream: false,
      tool_choice: "auto",
    })
  })

  it("streamt Thinking und Tool-Aufruf-Fragmente bei streamToolCallParts", async () => {
    const encoder = new TextEncoder()
    const chunks = [
      encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"Prüfe Tool "}}]}\n\n'),
      encoder.encode(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"ping_test","arguments":"{\\"token\\":"}}]}}]}\n\n',
      ),
      encoder.encode(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ok\\"}"}}]}}]}\n\n',
      ),
      encoder.encode("data: [DONE]\n\n"),
    ]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(chunk))
        controller.close()
      },
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 200 })),
    )

    const updates: Array<{ content: string; reasoning: string }> = []
    const result = await streamToolCallParts(
      {
        ...emptyLlmSettings,
        ...emptyLlmSelection,
        baseUrl: "https://api.example.com/v1",
        model: "gpt-4o-mini",
        streaming: true,
      },
      (parts) => {
        updates.push(parts)
      },
    )

    expect(updates).toEqual([
      { content: "", reasoning: "Prüfe Tool " },
      { content: 'Tool-Aufruf: ping_test({"token":)', reasoning: "Prüfe Tool " },
      { content: 'Tool-Aufruf: ping_test({"token":"ok"})', reasoning: "Prüfe Tool " },
    ])
    expect(result).toEqual({
      content: 'Tool-Aufruf: ping_test({"token":"ok"})',
      reasoning: "Prüfe Tool",
    })
  })
})

describe("runEditorChatTurn", () => {
  it("wendet edit-Tool-Aufruf an, fügt Tool-Nachricht an und stoppt bis zur nächsten User-Nachricht", async () => {
    const { hashLine } = await import("./hashline")
    const original = "<p>Alt</p>"
    const h1 = hashLine(original)
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "edit",
                        arguments: JSON.stringify({
                          edits: `REPLACE 1:${h1}\n<p>Neu</p>\nEND`,
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)

    const result = await runEditorChatTurn({
      config: {
        ...emptyLlmSettings,
        ...emptyLlmSelection,
        editFormat: "hashline",
        baseUrl: "https://api.example.com/v1",
        model: "gpt-4o-mini",
        streaming: false,
      },
      fileName: "index.html",
      initialContent: original,
      initialMessages: [
        { _tag: "System", content: "hash-sys" },
        { _tag: "User", content: "dts" },
        { _tag: "User", content: "file" },
        { _tag: "User", content: "Ändere Alt zu Neu" },
      ],
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.updatedContent).toBe("<p>Neu</p>")
    expect(result.appliedCount).toBe(1)
    expect(result.messages).toHaveLength(6)
    expect(result.messages[4]?._tag).toBe("Assistant")
    expect(result.messages[5]).toEqual({
      _tag: "Tool",
      toolCallId: "call_1",
      content: expect.stringContaining("Änderungen angewendet"),
    })
  })

  it("sendet Hashline-Fehler sofort an das LLM zurück und wendet korrigierten Versuch an", async () => {
    const { hashLine } = await import("./hashline")
    const original = "<p>Alt</p>"
    const h1 = hashLine(original)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call_bad",
                      type: "function",
                      function: {
                        name: "edit",
                        arguments: JSON.stringify({
                          edits: "REPLACE 1:000\n<p>Neu</p>\nEND",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call_ok",
                      type: "function",
                      function: {
                        name: "edit",
                        arguments: JSON.stringify({
                          edits: `REPLACE 1:${h1}\n<p>Neu</p>\nEND`,
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal("fetch", fetchMock)

    const updates: Array<{
      readonly completedTurns: ReadonlyArray<{
        readonly content: string
        readonly reasoning: string
        readonly isError: boolean
      }>
      readonly activeTurn: { readonly content: string; readonly reasoning: string }
    }> = []
    const result = await runEditorChatTurn({
      config: {
        ...emptyLlmSettings,
        ...emptyLlmSelection,
        editFormat: "hashline",
        baseUrl: "https://api.example.com/v1",
        model: "gpt-4o-mini",
        streaming: false,
      },
      fileName: "index.html",
      initialContent: original,
      initialMessages: [{ _tag: "User", content: "Ändere Alt zu Neu" }],
      onUpdate: (parts) => {
        updates.push(parts)
      },
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.updatedContent).toBe("<p>Neu</p>")
    expect(
      result.turns.map((turn) => ({
        isError: turn.isError,
        hasEdit: turn.content.includes("Tool-Aufruf: edit"),
        hasToolErr:
          turn.toolDetails?.[0]?.result.includes("Fehler beim Anwenden der Änderungen") ?? false,
      })),
    ).toEqual([
      { isError: false, hasEdit: true, hasToolErr: true },
      { isError: false, hasEdit: true, hasToolErr: false },
    ])
    expect(updates.at(-1)?.completedTurns).toHaveLength(1)
    expect(result.messages[2]).toEqual({
      _tag: "Tool",
      toolCallId: "call_bad",
      content: expect.stringContaining("Hash stimmt nicht überein"),
    })
    expect(result.messages[4]).toEqual({
      _tag: "Tool",
      toolCallId: "call_ok",
      content: expect.stringContaining("Änderungen angewendet"),
    })
  })

  it("führt search- und read-Werkzeuge in Schleife aus und wendet danach edit an", async () => {
    const { hashLine } = await import("./hashline")
    const original = "<h1>Kopf</h1>\n<p>Alt</p>\n<footer>Ende</footer>"
    const h2 = hashLine("<p>Alt</p>")
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call_search",
                      type: "function",
                      function: {
                        name: "search",
                        arguments: JSON.stringify({ query: "Alt" }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call_read",
                      type: "function",
                      function: {
                        name: "read",
                        arguments: JSON.stringify({ startLine: 2, endLine: 3 }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call_edit",
                      type: "function",
                      function: {
                        name: "edit",
                        arguments: JSON.stringify({
                          edits: `REPLACE 2:${h2}\n<p>Neu</p>\nEND`,
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal("fetch", fetchMock)

    const result = await runEditorChatTurn({
      config: {
        ...emptyLlmSettings,
        ...emptyLlmSelection,
        editFormat: "hashline",
        baseUrl: "https://api.example.com/v1",
        model: "gpt-4o-mini",
        streaming: false,
      },
      fileName: "index.html",
      initialContent: original,
      initialMessages: [{ _tag: "User", content: "Ändere Alt zu Neu" }],
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as {
      tools?: Array<{ function?: { name?: string } }>
    }
    expect(firstBody.tools?.map((t) => t.function?.name)).toEqual([
      "edit",
      "read",
      "search",
      "write",
    ])
    expect(result.updatedContent).toBe("<h1>Kopf</h1>\n<p>Neu</p>\n<footer>Ende</footer>")
    expect(result.appliedCount).toBe(1)
    expect(result.messages[2]).toEqual({
      _tag: "Tool",
      toolCallId: "call_search",
      content: expect.stringContaining(`2:${h2}|<p>Alt</p>`),
    })
    expect(result.messages[4]).toEqual({
      _tag: "Tool",
      toolCallId: "call_read",
      content: expect.stringContaining("Zeilen 2–3 von 3"),
    })
    expect(result.turns.map((turn) => turn.content)).toEqual([
      'Tool-Aufruf: search ("Alt")',
      "Tool-Aufruf: read (Zeilen 2–3)",
      expect.stringContaining("Tool-Aufruf: edit"),
    ])
  })

  it("wendet write-Tool-Aufruf an, schreibt Datei neu und stoppt bis zur nächsten User-Nachricht", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call_write",
                      type: "function",
                      function: {
                        name: "write",
                        arguments: JSON.stringify({
                          content: "<!doctype html>\n<p>Komplett neu</p>",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)

    const result = await runEditorChatTurn({
      config: {
        ...emptyLlmSettings,
        ...emptyLlmSelection,
        editFormat: "unified-diff",
        baseUrl: "https://api.example.com/v1",
        model: "gpt-4o-mini",
        streaming: false,
      },
      fileName: "index.html",
      initialContent: "<p>Alt</p>",
      initialMessages: [{ _tag: "User", content: "Schreibe die Datei neu" }],
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.updatedContent).toBe("<!doctype html>\n<p>Komplett neu</p>")
    expect(result.appliedCount).toBe(1)
    expect(result.messages[2]).toEqual({
      _tag: "Tool",
      toolCallId: "call_write",
      content: "Datei `index.html` wurde neu geschrieben (2 Zeilen).",
    })
    expect(result.turns[0]?.content).toBe("Tool-Aufruf: write (2 Zeilen)")
  })
})

describe("LanguageModel-API", () => {
  it("erkennt LanguageModel auch dann, wenn es wie im Browser eine Konstruktor-Funktion ist", async () => {
    class FakeLanguageModel {
      static availability = vi.fn(async () => "available")
      static create = vi.fn()
    }
    vi.stubGlobal("LanguageModel", FakeLanguageModel)

    await expect(detectLanguageModelAvailability()).resolves.toBe(true)
    expect(FakeLanguageModel.availability).toHaveBeenCalledTimes(1)
  })

  it("wirft eine verständliche Fehlermeldung, wenn LanguageModel im Browser fehlt", async () => {
    vi.stubGlobal("LanguageModel", undefined)

    await expect(
      testLlmConnection(
        {
          ...emptyLlmSettings,
          ...emptyLlmSelection,
          enabled: true,
          provider: "language-model",
          streaming: false,
        },
        "chat",
      ),
    ).rejects.toThrow("LanguageModel-API")
  })

  it("wirft bei availability === 'unavailable'", async () => {
    vi.stubGlobal("LanguageModel", {
      availability: vi.fn(async () => "unavailable"),
      create: vi.fn(),
    })

    await expect(
      testLlmConnection(
        {
          ...emptyLlmSettings,
          ...emptyLlmSelection,
          enabled: true,
          provider: "language-model",
          streaming: false,
        },
        "chat",
      ),
    ).rejects.toThrow("nicht verfügbar")
  })

  it("testet Chat über LanguageModel.create und session.prompt und zerstört die Session", async () => {
    const destroy = vi.fn()
    const prompt = vi.fn(async () => "ok")
    const create = vi.fn(async () => ({ prompt, promptStreaming: vi.fn(), destroy }))
    vi.stubGlobal("LanguageModel", {
      availability: vi.fn(async () => "available"),
      create,
    })

    const result = await testLlmConnection(
      {
        ...emptyLlmSettings,
        ...emptyLlmSelection,
        enabled: true,
        provider: "language-model",
        streaming: false,
      },
      "chat",
    )

    expect(create).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledWith("Antworte nur mit: ok", undefined)
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(result.content).toBe("ok")
  })

  it("streamt Chunks über session.promptStreaming", async () => {
    const destroy = vi.fn()
    const promptStreaming = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield "o"
        yield "k"
      },
    }))
    vi.stubGlobal("LanguageModel", {
      availability: vi.fn(async () => "available"),
      create: vi.fn(async () => ({ prompt: vi.fn(), promptStreaming, destroy })),
    })

    const updates: Array<string> = []
    const result = await streamChatParts(
      {
        ...emptyLlmSettings,
        ...emptyLlmSelection,
        enabled: true,
        provider: "language-model",
        streaming: true,
      },
      "Sag ok",
      (parts) => updates.push(parts.content),
    )

    expect(updates).toEqual(["o", "ok"])
    expect(result).toEqual({ content: "ok", reasoning: "" })
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it("informiert über Download-Fortschritt, wenn availability === 'downloading' ist", async () => {
    const destroy = vi.fn()
    const promptStreaming = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield "ok"
      },
    }))
    const create = vi.fn(
      async (options?: {
        monitor?: (m: {
          addEventListener: (type: string, cb: (e: { loaded: number }) => void) => void
        }) => void
      }) => {
        options?.monitor?.({
          addEventListener: (_type, cb) => {
            cb({ loaded: 0.42 })
          },
        })
        return { prompt: vi.fn(), promptStreaming, destroy }
      },
    )
    vi.stubGlobal("LanguageModel", {
      availability: vi.fn(async () => "downloading"),
      create,
    })

    const updates: Array<string> = []
    const result = await streamChatParts(
      {
        ...emptyLlmSettings,
        ...emptyLlmSelection,
        enabled: true,
        provider: "language-model",
        streaming: true,
      },
      "Sag ok",
      (parts) => updates.push(parts.content),
    )

    expect(updates).toEqual([
      "Lade Browser-KI-Modell herunter …",
      "Lade Browser-KI-Modell herunter (42 %) …",
      "ok",
    ])
    expect(result).toEqual({ content: "ok", reasoning: "" })
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it("wendet Hashline-Edits aus Markdown-Codeblock über LanguageModel-API an", async () => {
    const { hashLine } = await import("./hashline")
    const original = "<p>Alt</p>"
    const h1 = hashLine(original)
    const destroy = vi.fn()
    const prompt = vi.fn(
      async () =>
        `Hier ist die Änderung:\n\`\`\`hashline\nREPLACE 1:${h1}\n<p>Neu</p>\nEND\n\`\`\``,
    )
    const create = vi.fn(async () => ({ prompt, promptStreaming: vi.fn(), destroy }))
    vi.stubGlobal("LanguageModel", {
      availability: vi.fn(async () => "available"),
      create,
    })

    const result = await runEditorChatTurn({
      config: {
        ...emptyLlmSettings,
        ...emptyLlmSelection,
        editFormat: "hashline",
        enabled: true,
        provider: "language-model",
        streaming: false,
      },
      fileName: "index.html",
      initialContent: original,
      initialMessages: [
        { _tag: "System", content: "hash-sys" },
        { _tag: "User", content: "Ändere Alt zu Neu" },
      ],
    })

    expect(create).toHaveBeenCalledWith({
      initialPrompts: [{ role: "system", content: "hash-sys" }],
    })
    expect(prompt).toHaveBeenCalledWith("Ändere Alt zu Neu", undefined)
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(result.updatedContent).toBe("<p>Neu</p>")
    expect(result.appliedCount).toBe(1)
  })

  it("gibt reine Textantwort ohne Edit-Block unverändert als Chat-Antwort zurück", async () => {
    const destroy = vi.fn()
    const prompt = vi.fn(async () => "Diese Datei enthält einen Absatz.")
    vi.stubGlobal("LanguageModel", {
      availability: vi.fn(async () => "available"),
      create: vi.fn(async () => ({ prompt, promptStreaming: vi.fn(), destroy })),
    })

    const result = await runEditorChatTurn({
      config: {
        ...emptyLlmSettings,
        ...emptyLlmSelection,
        editFormat: "hashline",
        enabled: true,
        provider: "language-model",
        streaming: false,
      },
      fileName: "index.html",
      initialContent: "<p>Alt</p>",
      initialMessages: [{ _tag: "User", content: "Was steht in der Datei?" }],
    })

    expect(result.updatedContent).toBeUndefined()
    expect(result.appliedCount).toBe(0)
    expect(result.turns[0]?.content).toBe("Diese Datei enthält einen Absatz.")
  })
})

describe("Modellfilter und Sortierung", () => {
  it("filtert per RegExp und sortiert Modellnamen alphabetisch", () => {
    expect(
      filterAndSortModelNames(["qwen3", "gpt-4o-mini", "claude-3", "gpt-4o"], "^gpt-"),
    ).toEqual(["gpt-4o", "gpt-4o-mini"])
    expect(filterAndSortModelNames(["z-model", "a-model", "m-model"], "[ungueltig")).toEqual([
      "a-model",
      "m-model",
      "z-model",
    ])
  })

  it("filtert und sortiert resolveModelOptions und resolveAllProviderModelOptions", () => {
    const options = resolveModelOptions(
      "Zebra=z-1, Alpha=a-1",
      ["gpt-4o", "claude-3"],
      "",
      false,
      "^(a-1|gpt-)",
    )
    expect(options.map((o) => o.label)).toEqual(["Alpha", "gpt-4o"])

    const providerOptions = resolveAllProviderModelOptions(
      [
        {
          id: "p1",
          name: "P1",
          enabled: true,
          baseUrl: "https://example.com/v1",
          apiKey: "",
          models: "zeta, alpha",
          modelFilter: "^(alpha|gpt)",
          discoveredModels: ["gpt-4o-mini", "claude-3"],
          editFormat: "",
          streaming: true,
          toolCalls: true,
          thinkingParam: "",
          thinkingLevels: "",
          extraArgs: "",
        },
        {
          id: "p2",
          name: "P2",
          enabled: true,
          baseUrl: "https://two.example.com/v1",
          apiKey: "",
          models: "beta, aardvark",
          modelFilter: "",
          discoveredModels: [],
          editFormat: "",
          streaming: true,
          toolCalls: true,
          thinkingParam: "",
          thinkingLevels: "",
          extraArgs: "",
        },
      ],
      {},
      "",
    )
    expect(providerOptions.map((o) => o.label)).toEqual([
      "alpha",
      "gpt-4o-mini",
      "aardvark",
      "beta",
    ])
  })
})
