import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const publicDir = join(root, 'public')
const modulesRoot = join(root, 'node_modules', '@deepseek-ai')
const webDist = join(modulesRoot, 'dsh-web-frontend', 'dist')
const extraClientPackages = [
  '@nanmicoder/dsh-agent-teams',
]
const excluded = new Set([
  // The Makers deployment has no native desktop directory chooser. The
  // native row is retained because the upstream Web composition selects it;
  // the browse twin would double-occupy the same UI seat.
  '@deepseek-ai/dsh-client-ui-directory-picker-browse',
  // Live Cordis editing assumes direct Host trust and opens a large secondary
  // RPC surface. Makers keeps the normal plugin inventory/settings UI but not
  // the self-modifying runtime panel.
  '@deepseek-ai/dsh-client-hmr',
  '@deepseek-ai/dsh-cordis-client-runner',
  '@deepseek-ai/dsh-client-ui-cordis',
])

function hash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function mustReplace(source, find, replacement, label) {
  if (!source.includes(find)) {
    throw new Error(`Published DSH agent-preset bundle no longer matches the Makers lock patch point: ${label}`)
  }
  return source.replace(find, replacement)
}

const CLIENT_MODULES_ID = '@deepseek-ai/dsh-client-modules'

function escapeHtmlAttribute(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function stripClientSuffix(spec) {
  return spec.endsWith('/client') ? spec.slice(0, -7) : spec
}

function orderByModuleGraph(entries) {
  const rowsById = new Map(entries.map((entry) => [entry.id, entry]))
  const ordered = []
  const placed = new Set()
  const open = []
  const visit = (entry) => {
    if (placed.has(entry.id)) return
    const cycleStart = open.indexOf(entry.id)
    if (cycleStart !== -1) {
      throw new Error(`client-modules: module graph cycle ${[...open.slice(cycleStart), entry.id].join(' -> ')}`)
    }
    open.push(entry.id)
    for (const name of entry.external ?? []) {
      const dependency = rowsById.get(name) ?? rowsById.get(stripClientSuffix(name))
      if (dependency === entry) {
        throw new Error(`client-modules: "${entry.id}" requests its own package in dsh.client.external`)
      }
      if (dependency !== undefined) visit(dependency)
    }
    open.pop()
    placed.add(entry.id)
    ordered.push(entry)
  }
  for (const entry of entries) visit(entry)
  return ordered
}

function stripSourceMapTrailer(source) {
  return source.replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/, '\n')
}

function patchGatewayBundle(source) {
  let next = mustReplace(
    source,
    `			start() {
				if (this.disposed) return;
				this.running = true;
				if (this.socket?.readyState === WebSocket.OPEN) return;
				const pending = this.keepAlive;
				if (pending === void 0) this.maintain();
				else pending.then(() => {
					this.maintain();
				});
			}`,
    `			start() {
				if (this.disposed) return;
				this.running = true;
			}`,
    'gateway mux start without websocket',
  )
  next = mustReplace(
    next,
    `		function remoteStreamUrl() {
			const location = globalThis.location;
			const base = location?.origin !== void 0 && location.origin !== "null" ? location.origin : INTERNAL_BASE;
			const url = new URL(REMOTE_STREAM_MUX_PATH, base);
			url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
			return url.href;
		}`,
    `		function resolveStreamBase() {
			const location = globalThis.location;
			return location?.origin !== void 0 && location.origin !== "null" ? location.origin : INTERNAL_BASE;
		}
		function remoteStreamUrl() {
			return new URL(REMOTE_STREAM_MUX_PATH, resolveStreamBase()).href;
		}`,
    'gateway mux http base',
  )
  return mustReplace(
    next,
    `			async *open(endpoint, payload, signal) {
				signal.throwIfAborted();
				const streamId = randomUUID();
				const inbox = new StreamInbox();
				let carrier;
				let opened = false;
				let terminal = false;
				const abort = () => {
					inbox.fail(signal.reason);
				};
				signal.addEventListener("abort", abort, { once: true });
				try {
					const socket = await this.waitForSocket(signal);
					signal.throwIfAborted();
					carrier = socket;
					this.streams.set(streamId, inbox);
					this.send(socket, {
						type: "open",
						streamId,
						endpoint,
						payload
					});
					opened = true;
					while (true) {
						const frame = await inbox.next();
						signal.throwIfAborted();
						if (frame.type === "item") {
							yield frame.value;
							continue;
						}
						terminal = true;
						if (frame.type === "error") throw new RemoteError(frame.error.code, frame.error.message, frame.error.details);
						return;
					}
				} finally {
					signal.removeEventListener("abort", abort);
					this.streams.delete(streamId);
					if (opened && !terminal && carrier?.readyState === WebSocket.OPEN) this.send(carrier, {
						type: "cancel",
						streamId
					});
				}
			}`,
    `			async *open(endpoint, payload, signal) {
				signal.throwIfAborted();
				const response = await fetch(new URL(REMOTE_STREAM_MUX_PATH, resolveStreamBase()), {
					method: "POST",
					headers: {
						"content-type": "application/json",
						accept: "text/event-stream"
					},
					body: JSON.stringify({
						endpoint,
						payload
					}),
					signal
				});
				if (!response.ok || response.body === null) throw new RemoteStreamCarrierError(\`api gateway: Remote stream SSE failed to open: HTTP \${String(response.status)}\`);
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				try {
					while (true) {
						const chunk = await reader.read();
						signal.throwIfAborted();
						if (chunk.done) return;
						buffer += decoder.decode(chunk.value, { stream: true });
						const parts = buffer.split("\\n\\n");
						buffer = parts.pop() ?? "";
						for (const part of parts) {
							const data = part.split("\\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\\n");
							if (data === "") continue;
							const frame = parseRemoteStreamServerMessage(data);
							if (frame.type === "item") {
								yield frame.value;
								continue;
							}
							if (frame.type === "error") throw new RemoteError(frame.error.code, frame.error.message, frame.error.details);
							return;
						}
					}
				} finally {
					try {
						await reader.cancel();
					} catch {}
				}
			}`,
    'gateway mux open via SSE',
  )
}

function patchSettingsBundle(source) {
  return mustReplace(
    source,
    'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";',
    'const persistence = "host";',
    'settings host persistence',
  )
}

function patchSettingsModelsBundle(source) {
  let next = mustReplace(
    source,
    '			intro: "Enter your API keys to use models from the following providers.",',
    '			intro: "Enter your API keys to use models from the following providers.",\n			officialProvided: "Models come from the official DeepSeek API. Image input is enabled for DeepSeek-V4-Flash-Vision. The key is read only from DEEPSEEK_API_KEY.",\n			learnMore: "Learn more",',
    'en official models copy',
  )
  next = mustReplace(
    next,
    '			intro: "填入各提供方的 API 密钥即可使用其模型。",',
    '			intro: "填入各提供方的 API 密钥即可使用其模型。",\n			officialProvided: "模型由 DeepSeek 原厂提供，已开启图片输入（DeepSeek-V4-Flash-Vision）。API Key 仅从环境变量 DEEPSEEK_API_KEY 读取。",\n			learnMore: "了解更多",',
    'zh official models copy',
  )
  next = mustReplace(
    next,
    '.zGbnIq_candidateId{font-family:var(--ds-font-family-code);overflow-wrap:anywhere;flex:auto;font-size:13px}',
    '.zGbnIq_candidateId{font-family:var(--ds-font-family-code);overflow-wrap:anywhere;flex:auto;font-size:13px}.zGbnIq_docsLink{color:#3b63f6;font-size:14px;font-weight:600;line-height:22px;text-decoration:none;width:fit-content}.zGbnIq_docsLink:hover{text-decoration:underline}',
    'models docs link css',
  )
  next = mustReplace(
    next,
    '			"section": "zGbnIq_section",',
    '			"section": "zGbnIq_section",\n			"docsLink": "zGbnIq_docsLink",',
    'models docs link class',
  )
  next = mustReplace(
    next,
    `		function ModelsSection(props) {
			const { controller, useSnapshot, operations, schema, t, renderSlot } = props;
			if (controller === void 0 || useSnapshot === void 0 || operations === void 0 || schema === void 0 || t === void 0) return null;
			return (0, react_jsx_runtime.jsx)(Loaded, {
				injected: {
					controller,
					useSnapshot,
					operations,
					schema,
					t
				},
				renderSlot
			});
		}`,
    `		function ModelsSection(props) {
			const { t } = props;
			if (t === void 0) return null;
			return (0, react_jsx_runtime.jsxs)("div", {
				className: ModelsSection_module_css_default["section"],
				children: [
					(0, react_jsx_runtime.jsx)("h2", {
						className: ModelsSection_module_css_default["title"],
						children: t("title")
					}),
					(0, react_jsx_runtime.jsx)("p", {
						className: ModelsSection_module_css_default["intro"],
						children: t("officialProvided")
					}),
					(0, react_jsx_runtime.jsx)("a", {
						className: ModelsSection_module_css_default["docsLink"],
						href: "https://api-docs.deepseek.com/",
						target: "_blank",
						rel: "noopener noreferrer",
						children: t("learnMore")
					})
				]
			});
		}`,
    'models section official env-only copy',
  )
  next = mustReplace(
    next,
    `			ctx.slots.inject("settings.onboarding", () => ctx.slots.register({
				name: "settings.onboarding",
				id: "welcome-notice",
				order: -100,
				inject: welcomeInjected
			}, WelcomeNotice));
`,
    '',
    'welcome notice onboarding slot',
  )
  return mustReplace(
    next,
    `			ctx.slots.inject("settings.onboarding", () => ctx.slots.register({
				name: "settings.onboarding",
				id: "deepseek-official",
				order: 0,
				inject: deepSeekOnboardingInjected
			}, DeepSeekOnboardingDialog));
`,
    '',
    'deepseek official onboarding slot',
  )
}

function patchModelSelectionBundle(source) {
  let next = mustReplace(
    source,
    '		var ModelDirectory = class {',
    `		function officialVisionGroups(groups) {
			const official = groups.find((group) => group.id === "deepseek-official")
				?? groups.find((group) => group.id === "deepseek");
			const listed = (official?.models ?? []).find((model) => model.id === "deepseek-v4-flash-vision-exp");
			const vision = listed ?? {
				id: "deepseek-v4-flash-vision-exp",
				name: "DeepSeek-V4-Flash-Vision-Exp",
				description: "多模态",
				...official?.models?.[0]?.reasoning ? { reasoning: official.models[0].reasoning } : {}
			};
			return [{
				id: official?.id ?? "deepseek-official",
				name: official?.name ?? "DeepSeek",
				models: [vision]
			}];
		}
		var ModelDirectory = class {`,
    'official vision catalog helper',
  )
  next = mustReplace(
    next,
    '			generation = 0;\n			disposed = false;',
    '			generation = 0;\n			inflightSelect = 0;\n			disposed = false;',
    'model select inflight flag',
  )
  next = mustReplace(
    next,
    `				this.store.set({
					current,
					routable: catalog.value.routableProviders.includes(current.provider),
					groups: catalog.value.groups,
					failures: catalog.value.failures,
					status: this.store.getSnapshot().status === "selecting" ? "selecting" : "ready",
					error: null
				});`,
    `				const officialGroups = officialVisionGroups(catalog.value.groups);
				const snapshot = this.store.getSnapshot();
				this.store.set({
					current: this.inflightSelect === 0 ? current : snapshot.current,
					routable: catalog.value.routableProviders.includes((this.inflightSelect === 0 ? current : snapshot.current)?.provider ?? current.provider),
					groups: officialGroups,
					failures: catalog.value.failures,
					status: snapshot.status === "selecting" ? "selecting" : "ready",
					error: null
				});`,
    'keep only official DeepSeek vision model',
  )
  next = mustReplace(
    next,
    `			async select(selection) {
				this.assertAvailable();
				const generation = ++this.generation;
				this.store.update((s) => {
					s.status = "selecting";
					s.error = null;
				});
				const result = await this.sessions.selectModel({
					sessionId: this.sessionId,
					provider: selection.provider,
					model: selection.model,
					...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }
				});
				if (this.disposed || generation !== this.generation) {
					if (!result.ok) throw new Error(\`\${result.error.code}: \${result.error.message}\`);
					return;
				}
				if (!result.ok) {
					this.store.update((s) => {
						s.status = "error";
						s.error = \`\${result.error.code}: \${result.error.message}\`;
					});
					throw new Error(\`session.selectModel failed: \${result.error.code}: \${result.error.message}\`);
				}
				this.store.update((s) => {
					s.status = "ready";
					s.error = null;
				});
				this.syncInputs();
			}`,
    `			async select(selection) {
				this.assertAvailable();
				const generation = ++this.generation;
				const previous = this.store.getSnapshot().current;
				const optimistic = {
					provider: selection.provider,
					model: selection.model,
					...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }
				};
				this.inflightSelect++;
				this.store.update((s) => {
					s.current = optimistic;
					s.routable = true;
					s.status = "ready";
					s.error = null;
				});
				try {
					const result = await this.sessions.selectModel({
						sessionId: this.sessionId,
						provider: selection.provider,
						model: selection.model,
						...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }
					});
					if (this.disposed || generation !== this.generation) {
						if (!result.ok) throw new Error(\`\${result.error.code}: \${result.error.message}\`);
						return;
					}
					if (!result.ok) throw new Error(\`session.selectModel failed: \${result.error.code}: \${result.error.message}\`);
					this.store.update((s) => {
						s.status = "ready";
						s.error = null;
					});
					this.syncInputs();
				} catch (error) {
					if (!this.disposed && generation === this.generation) {
						this.store.update((s) => {
							s.current = previous;
							s.status = "error";
							s.error = error instanceof Error ? error.message : String(error);
						});
					}
					throw error;
				} finally {
					this.inflightSelect--;
				}
			}`,
    'optimistic model select',
  )
  next = mustReplace(
    next,
    `			const settleSelection = (accepted) => {
				if (accepted) {
					if (rootRef.current !== null) close(true);
					return;
				}`,
    `			const settleSelection = (accepted) => {
				if (accepted) return;`,
    'do not close menu after in-flight select',
  )
  next = mustReplace(
    next,
    `			const choose = (selection) => {
				if (state.current?.provider === selection.provider && state.current.model === selection.model) {
					close(true);
					return;
				}
				lastActionRef.current = "select";
				select(selection).then(settleSelection);
			};`,
    `			const choose = (selection) => {
				if (state.current?.provider === selection.provider && state.current.model === selection.model) {
					close(true);
					return;
				}
				lastActionRef.current = "select";
				close(true);
				select(selection).then(settleSelection);
			};`,
    'close model menu immediately',
  )
  next = mustReplace(
    next,
    `				lastActionRef.current = "select";
				select(selection).then(settleSelection);
			};
			const waiting = state.current === null && state.status === "loading";`,
    `				lastActionRef.current = "select";
				close(true);
				select(selection).then(settleSelection);
			};
			const waiting = state.current === null && state.status === "loading";`,
    'close effort menu immediately',
  )
  return next
}

function patchAgentPresetBundle(source) {
  let next = source
  next = mustReplace(
    next,
    '			presetCordisDescription: "Built for creating custom agent presets, with all Standard mode capabilities plus runtime inspection, plugin experiments, and preset-authoring guidance.",\n			duplicate: "Duplicate",',
    '			presetCordisDescription: "Built for creating custom agent presets, with all Standard mode capabilities plus runtime inspection, plugin experiments, and preset-authoring guidance.",\n			presetMakersName: "Makers mode",\n			presetMakersDescription: "A DSH Agent that uses EdgeOne Makers MCP tools, Sandbox, and AI Gateway.",\n			presetUnavailable: "This mode cannot be selected on EdgeOne Makers",\n			duplicate: "Duplicate",',
    'en locale',
  )
  next = mustReplace(
    next,
    '			presetCordisDescription: "用于创建自定义 Agent preset：具备标准模式的全部能力，并提供运行时检查、插件实验和 preset 创作指导。",\n			duplicate: "复制",',
    '			presetCordisDescription: "用于创建自定义 Agent preset：具备标准模式的全部能力，并提供运行时检查、插件实验和 preset 创作指导。",\n			presetMakersName: "Makers 模式",\n			presetMakersDescription: "使用 EdgeOne Makers MCP 工具、Sandbox 与 AI Gateway 的 DSH Agent。",\n			presetUnavailable: "该模式在 EdgeOne Makers 上不可选择",\n			duplicate: "复制",',
    'zh locale',
  )
  next = mustReplace(
    next,
    `		};
		/**
		* Resolve preset display copy without making user-authored metadata translatable.`,
    `		};
		function isLockedBuiltInPreset(id) {
			return Object.prototype.hasOwnProperty.call(BUILT_IN_PRESET_KEYS, id);
		}
		/**
		* Resolve preset display copy without making user-authored metadata translatable.`,
    'lock helper',
  )
  next = mustReplace(
    next,
    `		function presetDisplayText(preset, t) {
			const keys = preset.trust === "system" ? BUILT_IN_PRESET_KEYS[preset.id] : void 0;`,
    `		function presetDisplayText(preset, t) {
			const keys = preset.id === "makers" ? {
				name: "presetMakersName",
				description: "presetMakersDescription"
			} : preset.trust === "system" ? BUILT_IN_PRESET_KEYS[preset.id] : void 0;`,
    'makers preset i18n',
  )
  next = mustReplace(
    next,
    `				items: state.options.map((option) => {
					const text = presetDisplayText(option, t);
					return {
						id: option.id,
						label: (0, react_jsx_runtime.jsxs)("span", {
							className: AgentPresetSeat_module_css_default.item,`,
    `				items: state.options.map((option) => {
					const text = presetDisplayText(option, t);
					const locked = isLockedBuiltInPreset(option.id);
					return {
						id: option.id,
						label: (0, react_jsx_runtime.jsxs)("span", {
							className: locked ? \`\${AgentPresetSeat_module_css_default.item} dsh-makers-tip dsh-makers-locked\` : AgentPresetSeat_module_css_default.item,
							"data-tip": locked ? t("presetUnavailable") : void 0,`,
    'seat menu items',
  )
  next = mustReplace(
    next,
    `				onSelect: (id) => {
					setOpen(false);
					const picked = state.options.find((option) => option.id === id);`,
    `				onSelect: (id) => {
					if (isLockedBuiltInPreset(id)) return;
					setOpen(false);
					const picked = state.options.find((option) => option.id === id);`,
    'seat menu select',
  )
  next = mustReplace(
    next,
    `			async makeDefault(id) {
				const failure = await writeDefaultPreset(this.ctx, id);`,
    `			async makeDefault(id) {
				if (isLockedBuiltInPreset(id)) return;
				const failure = await writeDefaultPreset(this.ctx, id);`,
    'makeDefault guard',
  )
  next = mustReplace(
    next,
    '.rtSEdW_card:hover:not(.rtSEdW_cardActive){background:var(--dsw-alias-interactive-bg-hover)}',
    '.rtSEdW_card:hover:not(.rtSEdW_cardActive):not([data-locked=true]){background:var(--dsw-alias-interactive-bg-hover)}.rtSEdW_card[data-locked=true]{opacity:.45;filter:grayscale(.2);cursor:not-allowed}',
    'locked card css',
  )
  next = mustReplace(
    next,
    `			const creatorButton = props.startCreatorDraft !== void 0 && state.rows.some((row) => row.id === "cordis") ? (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: AgentPresetSection_module_css_default.creatorButton,
				disabled: !state.authorable,
				title: state.authorable ? void 0 : t("duplicateUnavailable"),
				onClick: () => {
					props.startCreatorDraft?.();
					props.close();
				},
				children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutline16, { size: 14 }), t("creatorDraft")]
			}) : null;`,
    `			const creatorButton = props.startCreatorDraft !== void 0 && state.rows.some((row) => row.id === "cordis") ? (0, react_jsx_runtime.jsx)("span", {
				className: "dsh-makers-tip",
				"data-tip": t("presetUnavailable"),
				children: (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: AgentPresetSection_module_css_default.creatorButton,
					disabled: true,
					children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutline16, { size: 14 }), t("creatorDraft")]
				})
			}) : null;`,
    'creator draft button',
  )
  next = mustReplace(
    next,
    `									children: group.map(({ row, text }) => (0, react_jsx_runtime.jsxs)("li", {
										className: row.broken !== void 0 ? \`\${AgentPresetSection_module_css_default.card} \${AgentPresetSection_module_css_default.cardBroken}\` : row.isDefault ? \`\${AgentPresetSection_module_css_default.card} \${AgentPresetSection_module_css_default.cardActive}\` : AgentPresetSection_module_css_default.card,
										children: [
											(0, react_jsx_runtime.jsxs)("button", {
												type: "button",
												className: AgentPresetSection_module_css_default.cardMain,
												"aria-pressed": row.isDefault,
												disabled: row.isDefault,
												"aria-disabled": row.broken !== void 0,
												"aria-label": \`\${row.broken !== void 0 ? t("brokenBadge") : row.isDefault ? t("inUse") : t("setDefault")}: \${text.name}\`,
												title: row.broken !== void 0 ? t("brokenBadge") : row.isDefault ? t("inUse") : t("setDefault"),`,
    `									children: group.map(({ row, text }) => (0, react_jsx_runtime.jsxs)("li", {
										className: row.broken !== void 0 ? \`\${AgentPresetSection_module_css_default.card} \${AgentPresetSection_module_css_default.cardBroken}\` : row.isDefault ? \`\${AgentPresetSection_module_css_default.card} \${AgentPresetSection_module_css_default.cardActive}\` : AgentPresetSection_module_css_default.card,
										"data-locked": isLockedBuiltInPreset(row.id) ? "true" : void 0,
										"data-tip": isLockedBuiltInPreset(row.id) ? t("presetUnavailable") : void 0,
										children: [
											(0, react_jsx_runtime.jsxs)("button", {
												type: "button",
												className: AgentPresetSection_module_css_default.cardMain,
												"aria-pressed": row.isDefault,
												disabled: isLockedBuiltInPreset(row.id) || row.isDefault,
												"aria-disabled": row.broken !== void 0,
												"aria-label": \`\${isLockedBuiltInPreset(row.id) ? t("presetUnavailable") : row.broken !== void 0 ? t("brokenBadge") : row.isDefault ? t("inUse") : t("setDefault")}: \${text.name}\`,
												title: isLockedBuiltInPreset(row.id) ? t("presetUnavailable") : row.broken !== void 0 ? t("brokenBadge") : row.isDefault ? t("inUse") : t("setDefault"),`,
    'settings cards',
  )
  next = mustReplace(
    next,
    `			async select(id) {
				if (this.store.getSnapshot().busy) return void 0;
				this.stage(id);
				await this.apply();
				return this.store.getSnapshot().error ?? void 0;
			}`,
    `			async select(id) {
				if (isLockedBuiltInPreset(id) || this.store.getSnapshot().busy) return void 0;
				this.stage(id);
				await this.apply();
				return this.store.getSnapshot().error ?? void 0;
			}`,
    'seat select guard',
  )
  next = mustReplace(
    next,
    `			stage(id, introduce = false) {
				this.staged = id;`,
    `			stage(id, introduce = false) {
				if (isLockedBuiltInPreset(id)) return;
				this.staged = id;`,
    'seat stage guard',
  )
  next = mustReplace(
    next,
    `					const chip = scope.slots.register({
						name: "conversation.hero.agentPreset",
						locale: "settings.agentPreset",
						inject: seatInjected
					}, AgentPresetSeat);
					const label = scope.slots.register({
						name: "conversation.session.header.actions",
						id: "agent-preset",
						order: -10,
						locale: "settings.agentPreset",
						inject: labelInjected
					}, AgentPresetLabel);
`,
    `					const chip = () => {};
					const label = () => {};
`,
    'hide agent preset seat and header label',
  )
  next = mustReplace(
    next,
    `			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "agent-presets",
				order: 20,
				label: () => ctx.locale.bind("settings.agentPreset")("nav"),
				locale: "settings.agentPreset",
				inject: sectionInjected
			}, AgentPresetSection));
`,
    '',
    'hide agent preset settings',
  )
  return next
}

function patchPermissionPresetsBundle(source) {
  let next = mustReplace(
    source,
    '			"description": "选择新会话的默认权限模式",',
    '			"description": "选择新会话在 EdgeOne Makers 沙箱中的默认权限：只读、读写文件，或包含命令与预览的 Full access",',
    'settings permission zh description',
  )
  next = mustReplace(
    next,
    '			"description": "Choose the default permission mode for new sessions",',
    '			"description": "Choose the default Makers sandbox permission for new sessions: read-only, file write, or Full access with commands and preview",',
    'settings permission en description',
  )
  next = mustReplace(
    next,
    '			"confirm.description": "启用完全权限后，新会话将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任后续任务时使用。",',
    '			"confirm.description": "启用完全权限后，新会话可以在 EdgeOne Makers 沙箱中直接运行命令并发布预览，且不再弹出确认。仍然无法访问你的本机。仅建议在你信任后续任务时使用。",',
    'settings full access zh confirm',
  )
  next = mustReplace(
    next,
    '			"confirm.description": "Full access lets new sessions reduce confirmation steps and perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust subsequent tasks.",',
    '			"confirm.description": "Full access lets new sessions run commands and publish previews in the EdgeOne Makers sandbox without extra confirmation. The local machine is still never accessible. Only use it when you trust subsequent tasks.",',
    'settings full access en confirm',
  )
  next = mustReplace(
    next,
    '			"confirm.description": "启用完全权限后，智能体将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。",',
    '			"confirm.description": "启用完全权限后，智能体可以在 EdgeOne Makers 沙箱中直接运行命令并发布预览，且不再弹出确认。仍然无法访问你的本机。仅建议在你信任当前任务时使用。",',
    'session full access zh confirm',
  )
  return mustReplace(
    next,
    '			"confirm.description": "Full access reduces confirmation steps and lets the agent perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust the current task.",',
    '			"confirm.description": "Full access lets the agent run commands and publish previews in the EdgeOne Makers sandbox without extra confirmation. The local machine is still never accessible. Only use it when you trust the current task.",',
    'session full access en confirm',
  )
}

function patchConversationBundle(source) {
  let next = source
  next = mustReplace(
    next,
    '			"access.confirm.description": "启用完全权限后，智能体将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。",',
    '			"access.confirm.description": "启用完全权限后，智能体可以在 EdgeOne Makers 沙箱中直接运行命令并发布预览，且不再弹出确认。仍然无法访问你的本机。仅建议在你信任当前任务时使用。",\n			"access.read-only.detail": "只能查看 EdgeOne Makers 沙箱：列出和读取文件。写入、运行命令或发布预览时会询问你确认。",\n			"access.workspace-write.detail": "可在 EdgeOne Makers 沙箱中读写文件。运行命令和发布预览时会询问你确认。",\n			"access.danger-full-access.detail": "开放全部 Makers 沙箱能力：文件、命令和预览，不再弹出确认。仍然无法访问本机。",',
    'conversation zh permission copy',
  )
  next = mustReplace(
    next,
    '			"access.confirm.description": "Full access reduces confirmation steps and lets the agent perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust the current task.",',
    '			"access.confirm.description": "Full access lets the agent run commands and publish previews in the EdgeOne Makers sandbox without extra confirmation. The local machine is still never accessible. Only use it when you trust the current task.",\n			"access.read-only.detail": "Inspect the EdgeOne Makers sandbox: list and read files. Writes, commands, and preview will ask you to confirm.",\n			"access.workspace-write.detail": "Read and write files in the EdgeOne Makers sandbox. Commands and preview will ask you to confirm.",\n			"access.danger-full-access.detail": "Full Makers sandbox access: files, commands, and preview, without extra confirmation. The local machine is still never accessible.",',
    'conversation en permission copy',
  )
  next = mustReplace(
    next,
    '					title: current?.description,',
    '					title: ["read-only", "workspace-write", "danger-full-access"].includes(currentValue) ? t(`access.${currentValue}.detail`) : current?.description,',
    'permission option makers tooltip',
  )
  next = mustReplace(
    next,
    '			"hero.chooseWorkspace": "选择工作区",',
    '			"hero.chooseWorkspace": "选择工作区",\n			"hero.cloudWorkspace": "EdgeOne 沙箱",\n			"placeholder.workspace": "正在准备沙箱…",',
    'conversation zh locale',
  )
  next = mustReplace(
    next,
    '			"hero.chooseWorkspace": "Choose workspace",',
    '			"hero.chooseWorkspace": "Choose workspace",\n			"hero.cloudWorkspace": "EdgeOne Sandbox",\n			"placeholder.workspace": "Preparing the sandbox…",',
    'conversation en locale',
  )
  next = mustReplace(
    next,
    '.pXSMma_workspace{max-width:min(100%,360px);min-height:28px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:16px;align-items:center;gap:4px;padding:0 8px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}.pXSMma_workspace:not(:disabled):hover,.pXSMma_workspace[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}.pXSMma_workspace:disabled{cursor:default}',
    '.pXSMma_workspace{max-width:min(100%,360px);min-height:28px;color:var(--dsw-alias-label-primary);cursor:default;background:0 0;border:none;border-radius:16px;align-items:center;gap:4px;padding:0 8px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}',
    'workspace chip static css',
  )
  next = mustReplace(
    next,
    `		function WorkspaceChip({ buttonRef, label, menuOpen = false, onClick, t }) {
			return (0, react_jsx_runtime.jsxs)("button", {
				ref: buttonRef,
				type: "button",
				className: HeroShell_module_css_default.workspace,
				"aria-label": t("hero.chooseWorkspace"),
				"aria-haspopup": "menu",
				"aria-expanded": menuOpen,
				onClick,
				children: [
					label === void 0 ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderClose16, {
						className: HeroShell_module_css_default.folder,
						size: 16
					}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpen16, {
						className: HeroShell_module_css_default.folder,
						size: 16
					}),
					(0, react_jsx_runtime.jsx)("span", {
						className: HeroShell_module_css_default.workspaceLabel,
						children: label ?? t("hero.chooseWorkspace")
					}),
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, {
						className: HeroShell_module_css_default.chevron,
						size: 12
					})
				]
			});
		}`,
    `		function WorkspaceChip({ buttonRef, label, menuOpen = false, onClick, t }) {
			return (0, react_jsx_runtime.jsxs)("span", {
				ref: buttonRef,
				className: HeroShell_module_css_default.workspace,
				"aria-label": t("hero.cloudWorkspace"),
				children: [
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpen16, {
						className: HeroShell_module_css_default.folder,
						size: 16
					}),
					(0, react_jsx_runtime.jsx)("span", {
						className: HeroShell_module_css_default.workspaceLabel,
						children: t("hero.cloudWorkspace")
					})
				]
			});
		}`,
    'workspace chip static',
  )
  next = mustReplace(
    next,
    `					(0, react_jsx_runtime.jsx)(WorkspaceChip, {
						buttonRef: pickerAnchor,
						label: chipTitle,
						menuOpen: pickerOpen,
						onClick: () => {
							setPickerOpen((open) => !open);
						},
						t
					}),`,
    `					(0, react_jsx_runtime.jsx)(WorkspaceChip, {
						buttonRef: pickerAnchor,
						label: chipTitle,
						menuOpen: false,
						onClick: () => {},
						t
					}),`,
    'workspace chip click',
  )
  next = mustReplace(
    next,
    `			const inert = sessionId === void 0 || hero && chipTitle === void 0;`,
    `			const inert = sessionId === void 0 && workspaces.items.length === 0;`,
    'composer starts without workspace picker',
  )
  next = mustReplace(
    next,
    `			(0, react.useEffect)(() => {
				if (pendingWorkspaceId === void 0) return;
				if (sessionWorkspace?.workspaceId === pendingWorkspaceId || workspaces.phase === "ready" && pendingWorkspace === void 0) setPendingWorkspaceId(void 0);
			}, [
				pendingWorkspaceId,
				sessionWorkspace?.workspaceId,
				workspaces.phase,
				pendingWorkspace
			]);`,
    `			(0, react.useEffect)(() => {
				if (pendingWorkspaceId === void 0) return;
				if (sessionWorkspace?.workspaceId === pendingWorkspaceId || workspaces.phase === "ready" && pendingWorkspace === void 0) setPendingWorkspaceId(void 0);
			}, [
				pendingWorkspaceId,
				sessionWorkspace?.workspaceId,
				workspaces.phase,
				pendingWorkspace
			]);
			(0, react.useEffect)(() => {
				if (sessionId !== void 0 || workspaces.phase !== "ready") return;
				const only = workspaces.items[0];
				if (only === void 0) return;
				selectWorkspace(only.workspaceId).catch(() => {});
			}, [sessionId, workspaces.phase, workspaces.items, selectWorkspace]);`,
    'auto-select the only sandbox workspace',
  )
  next = mustReplace(
    next,
    `					onRequestWorkspace: () => {
						setPickerOpen(true);
					}`,
    `					onRequestWorkspace: () => {}`,
    'composer does not open a workspace picker',
  )
  return next
}

function patchWorkspaceBundle(source) {
  let next = source
  next = mustReplace(
    next,
    '			"section.workspaces": "工作区",',
    '			"section.workspaces": "EdgeOne 沙箱",',
    'workspace zh section',
  )
  next = mustReplace(
    next,
    '			"section.workspaces": "Workspaces",',
    '			"section.workspaces": "EdgeOne Sandbox",',
    'workspace en section',
  )
  next = mustReplace(
    next,
    `					expanded,
					containsCurrent: g.key === currentGroup,
					sessions: expanded ? g.sessions.map((session) => sessionNode(session, descendants, pendingInteractions)) : []`,
    `					expanded: true,
					containsCurrent: g.key === currentGroup,
					sessions: g.sessions.map((session) => sessionNode(session, descendants, pendingInteractions))`,
    'always expand workspace groups',
  )
  next = mustReplace(
    next,
    `					const target = recentWorkspace(workspace.items, sessions.byId);
					if (target === void 0) {
						initial = "done";
						return;
					}`,
    `					const target = recentWorkspace(workspace.items, sessions.byId);
					if (target === void 0) {
						if (workspace.items.length === 0) {
							initial = "adopting";
							const adopt = (path) => {
								if (disposed || !path) throw new Error("sandbox workspace path unavailable");
								const latest = this.workspaces.list.getSnapshot().items[0];
								if (latest) return { ok: true, value: { workspace: latest } };
								return this.workspaces.create({ path });
							};
							const finish = (sessionId) => {
								if (disposed || sessionId === void 0) return;
								if (this.sessions.list.getSnapshot().current === void 0) this.sessions.open(sessionId);
								initial = "done";
							};
							const failed = (reason) => {
								if (disposed) return;
								console.warn("sandbox workspace adopt failed:", reason);
								setTimeout(() => {
									if (!disposed && initial === "adopting") initial = "waiting";
								}, 1500);
							};
							setTimeout(() => {
								if (disposed) return;
								const ready = this.workspaces.list.getSnapshot().items[0];
								if (ready) {
									this.connectWorkspace(ready.workspaceId).then(finish, failed);
									return;
								}
								this.pickDirectory().then(adopt).then((result) => {
									if (disposed) return;
									if (!result.ok) throw new Error(result.error.message);
									return this.connectWorkspace(result.value.workspace.workspaceId);
								}).then(finish, failed);
							}, 800);
							return;
						}
						initial = "done";
						return;
					}`,
    'auto-adopt empty sandbox workspace',
  )
  next = mustReplace(
    next,
    `								children: [
									(0, react_jsx_runtime.jsx)(ProjectRowItem, {
										group,
										home,
										t,
										onToggle: () => {
											if (group.expanded) setExpandedSessionGroups((keys) => keys.filter((key) => key !== group.key));
											setGroupExpanded(group.key, !group.expanded);
										},
										onCreate: () => {
											if (group.workspaceId !== void 0) {
												setGroupExpanded(group.key, true);
												startSession(group.workspaceId);
											}
										},
										drag: workspaceDragProps,
										actions: group.workspaceId === void 0 ? void 0 : {
											rename: () => {
												/* v8 ignore next -- narrowing guard: the actions object exists only for real-workspace groups. */
												if (group.workspaceId !== void 0) onRenameRequest(group.workspaceId, group.label);
											},
											delete: () => {
												/* v8 ignore next -- narrowing guard: the actions object exists only for real-workspace groups. */
												if (group.workspaceId !== void 0) onDeleteRequest(group.workspaceId, group.label);
											}
										}
									}),
									(sessionsExpanded ? group.sessions : collapsed.rows).map((node) => {`,
    `								children: [
									(sessionsExpanded ? group.sessions : collapsed.rows).map((node) => {`,
    'hide workspace project row',
  )
  next = mustReplace(
    next,
    `								}), directoryFlowAvailable && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
									label: t("workspace.add"),
									side: "bottom",
									delayMs: 500,
									children: (0, react_jsx_runtime.jsx)("button", {
										ref: wsPlusRef,
										type: "button",
										className: WorkspaceBrowser_module_css_default.iconButton,
										"aria-label": t("workspace.add"),
										onClick: () => {
											setWsPickerOpen((v) => !v);
										},
										children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconProjectAddOutline16, { size: wide ? 16 : 18 })
									})
								})]`,
    `								})]`,
    'workspace add button',
  )
  next = mustReplace(
    next,
    `				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: WorkspaceBrowser_module_css_default.sectionHeader,`,
    `				children: [
					wide && (0, react_jsx_runtime.jsxs)("div", {
						className: WorkspaceBrowser_module_css_default.sectionHeader,`,
    'hide empty rail section header',
  )
  return next
}

function patchAgentTeamsBundle(source) {
  let next = source
  next = mustReplace(
    next,
    'const ACTIVITY_STATE_URL = "/plugins/dsh-agent-teams/state";',
    'const ACTIVITY_STATE_URL = "/api/agent-teams/state";',
    'agent-teams state url',
  )
  next = mustReplace(
    next,
    'const ACTIVITY_HALT_URL = "/plugins/dsh-agent-teams/halt";',
    'const ACTIVITY_HALT_URL = "/api/agent-teams/halt";',
    'agent-teams halt url',
  )
  next = mustReplace(
    next,
    'const PLAN_URL = "/plugins/dsh-agent-teams/plan";',
    'const PLAN_URL = "/api/agent-teams/plan";',
    'agent-teams plan url',
  )
  return next
}

function patchLocaleBundle(source) {
  return mustReplace(
    source,
    `		function resolveInitialLocale(locales) {
			return detectBrowserLocale(locales) ?? "en";
		}`,
    `		function resolveInitialLocale(locales) {
			if (typeof window !== "undefined" && location.hostname.endsWith(".edgeone.dev")) return "en";
			return locales.some((locale) => locale.id === "zh") ? "zh" : "en";
		}`,
    'hostname default locale',
  )
}

function patchSessionLogExportBundle(source) {
  return mustReplace(
    source,
    `					const response = await this.fetcher(url, {
						method: "HEAD",
						signal
					});
					if (!response.ok) {
						const detail = await response.text().catch(() => "");
						throw new Error(\`Export failed: HTTP \${response.status}\${detail === "" ? "" : \` \${detail}\`}\`);
					}
					this.save(url.toString(), sessionLogZipFilename(sessionId));`,
    `					const response = await this.fetcher(url, {
						method: "GET",
						signal
					});
					if (!response.ok) {
						const detail = await response.text().catch(() => "");
						throw new Error(\`Export failed: HTTP \${response.status}\${detail === "" ? "" : \` \${detail}\`}\`);
					}
					const blob = await response.blob();
					if (this.disposed || signal.aborted) return;
					const objectUrl = URL.createObjectURL(blob);
					this.save(objectUrl, sessionLogZipFilename(sessionId));
					setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);`,
    'session log blob download',
  )
}

function packageDirOf(name) {
  return join(root, 'node_modules', ...name.split('/'))
}

async function officialClientPackageDirs() {
  const rows = []
  for (const directory of await readdir(modulesRoot)) {
    rows.push(join(modulesRoot, directory))
  }
  return rows
}

function patchClientBundle(name, source) {
  if (name === '@deepseek-ai/dsh-api-gateway') return patchGatewayBundle(source)
  if (name === '@deepseek-ai/dsh-client-ui-agent-preset') return patchAgentPresetBundle(source)
  if (name === '@deepseek-ai/dsh-client-ui-permission-presets') return patchPermissionPresetsBundle(source)
  if (name === '@deepseek-ai/dsh-client-ui-conversation') return patchConversationBundle(source)
  if (name === '@deepseek-ai/dsh-client-ui-workspace') return patchWorkspaceBundle(source)
  if (name === '@deepseek-ai/dsh-client-ui-settings') return patchSettingsBundle(source)
  if (name === '@deepseek-ai/dsh-client-ui-settings-models') return patchSettingsModelsBundle(source)
  if (name === '@deepseek-ai/dsh-client-ui-model-selection') return patchModelSelectionBundle(source)
  if (name === '@deepseek-ai/dsh-session-log-export') return patchSessionLogExportBundle(source)
  if (name === '@deepseek-ai/dsh-client-locale') return patchLocaleBundle(source)
  if (name === '@nanmicoder/dsh-agent-teams') return patchAgentTeamsBundle(source)
  return source
}

async function readClientPackage(packageDir) {
  let manifest
  try { manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) } catch { return undefined }
  const client = manifest.dsh?.client
  if (client?.platform !== 'web' || excluded.has(manifest.name)) return undefined
  let source
  try { source = await readFile(join(packageDir, 'lib', 'client.js'), 'utf8') } catch { return undefined }
  return { manifest, client, source: patchClientBundle(manifest.name, source) }
}

async function clientPackages() {
  const rows = []
  const sources = new Map()
  const packageDirs = [
    ...await officialClientPackageDirs(),
    ...extraClientPackages.map(packageDirOf),
  ]
  for (const packageDir of packageDirs) {
    const loaded = await readClientPackage(packageDir)
    if (!loaded) continue
    const { manifest, client, source } = loaded
    const target = join(publicDir, 'plugins', ...manifest.name.split('/'), 'client.js')
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, source)
    const rev = hash(source)
    const inject = Array.isArray(client.inject) ? client.inject : []
    const external = Array.isArray(client.external) ? client.external : []
    rows.push({
      id: manifest.name,
      url: `/plugins/${manifest.name}/client.js?rev=${rev}`,
      rev,
      ...(inject.length > 0 ? { inject } : {}),
      ...(external.length > 0 ? { external } : {}),
      ...(client.immediately === true ? { immediately: true } : {}),
    })
    sources.set(manifest.name, source)
  }
  for (const name of extraClientPackages) {
    if (!sources.has(name)) throw new Error(`Expected extra client plugin ${name} in the DSH Web roster.`)
  }
  return {
    rows: orderByModuleGraph(rows),
    sources,
  }
}

async function writeComboBatch(phase, ids, sources) {
  if (ids.length === 0) throw new Error(`DSH Web ${phase} batch is empty.`)
  const script = ids.map((id) => {
    const source = sources.get(id)
    if (source === undefined) throw new Error(`DSH Web ${phase} batch is missing ${id}.`)
    return stripSourceMapTrailer(source)
  }).join('\n')
  const rev = hash(script)
  const relative = `/plugins/_batch/${phase}.js?rev=${rev}`
  const target = join(publicDir, 'plugins', '_batch', `${phase}.js`)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, script)
  return {
    phase,
    url: relative,
    rev,
    entries: ids,
  }
}

const makersActionsHead = [
  '<!-- dsh-makers-actions -->',
  '<style>',
  '[class*="_centerCol"]{position:relative;container:dsh-center / inline-size}',
  '[class*="_titleRow"]{position:relative}',
  '[class*="_composerHero"]{z-index:5}',
  '#dsh-makers-chrome{position:absolute;top:0;left:16px;right:auto;z-index:1;display:flex;align-items:center;justify-content:flex-start;box-sizing:border-box;height:50px;padding:8px;pointer-events:none}',
  '#dsh-makers-chrome>*{pointer-events:auto}',
  '#dsh-makers-actions{position:relative;z-index:1;display:flex;align-items:center;gap:2px;margin:0 8px 0 0;padding:0;border:none;background:transparent;font-family:inherit;flex:none}',
  '#dsh-makers-actions[data-docked=true]{position:static}',
  '#dsh-makers-actions a{display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 12px;border:none;border-radius:9px;color:#57606a;background:transparent;text-decoration:none;font:inherit;font-size:14px;font-weight:500;line-height:20px;white-space:nowrap;cursor:pointer;transition:background .16s,color .16s}',
  '#dsh-makers-actions a:hover{background:#f2f4f7;color:#1f2328}',
  '#dsh-makers-actions a:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3964fe);outline-offset:1px}',
  '#dsh-makers-actions svg{flex:none}',
  '@container dsh-center (max-width:880px){#dsh-makers-actions .dsh-makers-action-label{display:none}#dsh-makers-actions a{padding:0 8px}}',
  '</style><script>',
  '(() => {',
  '  const intl = location.hostname.endsWith(".edgeone.dev");',
  '  document.documentElement.lang = intl ? "en" : "zh-CN";',
  '  const repoHref = "https://github.com/NingYuanLee/deepseek-harness-EdgeOne";',
  '  const copy = {',
  '    zh: { github: "GitHub 源码" },',
  '    en: { github: "GitHub" }',
  '  };',
  '  const localeOf = () => {',
  '    const lang = (document.documentElement.lang || "").toLowerCase();',
  '    if (lang.startsWith("en")) return "en";',
  '    if (lang.startsWith("zh")) return "zh";',
  '    return intl ? "en" : "zh";',
  '  };',
  '  const githubIcon = \'<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8"/></svg>\';',
  '  const mount = () => {',
  '    if (document.getElementById("dsh-makers-actions")) return;',
  '    const nav = document.createElement("nav");',
  '    nav.id = "dsh-makers-actions";',
  '    nav.setAttribute("aria-label", "GitHub");',
  '    nav.dataset.docked = "false";',
  '    const github = document.createElement("a");',
  '    github.href = repoHref;',
  '    github.target = "_blank";',
  '    github.rel = "noopener noreferrer";',
  '    github.innerHTML = githubIcon + \'<span class="dsh-makers-action-label"></span>\';',
  '    nav.append(github);',
  '    const chrome = document.createElement("div");',
  '    chrome.id = "dsh-makers-chrome";',
  '    const centerCol = () => document.querySelector("[class*=\\"_centerCol\\"]");',
  '    const titleRow = () => document.querySelector("[class*=\\"_titleRow\\"]");',
  '    const headerOf = (row) => row?.closest("header") || row?.parentElement || null;',
  '    const headerVisible = (header) => {',
  '      if (!header) return false;',
  '      if ([...header.classList].some((name) => name.includes("headerHidden"))) return false;',
  '      const style = getComputedStyle(header);',
  '      return style.display !== "none" && style.visibility !== "hidden";',
  '    };',
  '    let adopting = false;',
  '    const adopt = () => {',
  '      if (adopting) return;',
  '      adopting = true;',
  '      try {',
  '        const host = centerCol();',
  '        if (!host) return;',
  '        const row = titleRow();',
  '        const header = headerOf(row);',
  '        const utilities = header?.querySelector("[class*=\\"_headerUtilities\\"]");',
  '        if (headerVisible(header) && utilities) {',
  '          if (nav.parentElement !== utilities) utilities.insertBefore(nav, utilities.firstChild);',
  '          chrome.remove();',
  '          nav.dataset.docked = "true";',
  '        } else {',
  '          if (chrome.parentElement !== host) host.append(chrome);',
  '          if (nav.parentElement !== chrome) chrome.append(nav);',
  '          nav.dataset.docked = "false";',
  '        }',
  '      } finally {',
  '        adopting = false;',
  '      }',
  '    };',
  '    const applyCopy = () => {',
  '      const t = copy[localeOf()];',
  '      github.title = t.github;',
  '      github.querySelector(".dsh-makers-action-label").textContent = t.github;',
  '    };',
  '    applyCopy();',
  '    new MutationObserver(applyCopy).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });',
  '    adopt();',
  '    const observer = new MutationObserver(adopt);',
  '    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });',
  '  };',
  '  if (document.body) mount();',
  '  else document.addEventListener("DOMContentLoaded", mount);',
  '})();',
  '</script>',
  '<!-- /dsh-makers-actions -->',
].join('\n')

function bootProtocolMarkup(graph) {
  const serialized = JSON.stringify(graph).replaceAll('<', '\\u003c')
  const queue = `(()=>{
const pendingQueue=[]
window.__ModuleLoader__={
  mode:"queue",
  pendingQueue,
  load(registration){pendingQueue.push(registration)},
  create(options){
    if(this.mode!=="queue")throw new Error("client-modules: window.__ModuleLoader__.create called after module-system boot")
    const index=pendingQueue.findIndex(registration=>registration.id===${JSON.stringify(CLIENT_MODULES_ID)})
    const registration=pendingQueue[index]
    if(registration===undefined)throw new Error(${JSON.stringify(`client-modules: HTML did not preload ${CLIENT_MODULES_ID}/client.js`)})
    pendingQueue.splice(index,1)
    const exports=registration.factory(specifier=>{
      throw new Error('client-modules: ${CLIENT_MODULES_ID}/client.js requested external "'+specifier+'" before the module system existed')
    })
    if(typeof exports!=="object"||exports===null||typeof exports.createClientModuleSystem!=="function"||typeof exports.apply!=="function"){
      throw new Error("client-modules: ${CLIENT_MODULES_ID}/client.js did not export the bootstrap module face")
    }
    return exports.createClientModuleSystem(this,{id:registration.id,exports},options)
  }
}
})()`
  const application = graph.batches.filter((batch) => batch.phase === 'application')
  const bootstrap = graph.batches.filter((batch) => batch.phase === 'bootstrap')
  return [
    `<script>${queue}<\/script>`,
    ...application.map((batch) => `<link rel="preload" as="script" href="${escapeHtmlAttribute(batch.url)}">`),
    ...bootstrap.map((batch) => `<script src="${escapeHtmlAttribute(batch.url)}"><\/script>`),
    `<script>globalThis["__DSH_BOOT__"] = ${serialized}<\/script>`,
  ].join('')
}

function makersBootstrap(graph) {
  return `${bootProtocolMarkup(graph)}<style>
.dsh-makers-tip[data-tip]{position:relative;display:inline-flex;max-width:100%;vertical-align:middle;cursor:not-allowed}
.dsh-makers-tip[data-tip]>:disabled{pointer-events:none}
.dsh-makers-locked{opacity:.45;cursor:not-allowed}
#dsh-makers-hover-tip{position:fixed;z-index:2147483647;pointer-events:none;background:var(--dsw-alias-label-primary,#1a1a1a);color:var(--dsw-alias-bg-layer-3,#fff);white-space:nowrap;border-radius:6px;padding:4px 8px;font-size:11px;line-height:17px;font-weight:400;max-width:min(320px,calc(100vw - 16px));box-shadow:0 4px 12px rgba(0,0,0,.18)}
#dsh-makers-hover-tip[hidden]{display:none!important}
</style><script>
(() => {
  const key = 'dsh-makers-web-conversation-id';
  let conversationId = localStorage.getItem(key);
  if (!conversationId) {
    conversationId = crypto.randomUUID();
    localStorage.setItem(key, conversationId);
  }
  window.__DSH_MAKERS_CONVERSATION_ID__ = conversationId;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    if (target.origin !== location.origin || (!target.pathname.startsWith('/api') && !target.pathname.startsWith('/rpc'))) {
      return nativeFetch(input, init);
    }
    const headers = new Headers(input instanceof Request ? input.headers : init.headers);
    headers.set('makers-conversation-id', conversationId);
    if (input instanceof Request) return nativeFetch(new Request(input, { ...init, headers }));
    return nativeFetch(input, { ...init, headers });
  };
})();
(() => {
  const id = 'dsh-makers-hover-tip';
  const hostOf = (node) => {
    if (!(node instanceof Element)) return null;
    const tip = (el) => el && el.getAttribute('data-tip') ? el : null;
    const from = (el) => el ? tip(el) || tip(el.querySelector('[data-tip]')) : null;
    return tip(node.closest('[data-tip]'))
      || from(node.closest('[role="menuitem"]'))
      || from([...node.children].find((child) => child.getAttribute('role') === 'menuitem'));
  };
  const bubble = () => {
    let el = document.getElementById(id);
    if (el) return el;
    el = document.createElement('div');
    el.id = id;
    el.setAttribute('role', 'tooltip');
    el.hidden = true;
    document.body.appendChild(el);
    return el;
  };
  const hide = () => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  };
  const show = (host) => {
    const text = host.getAttribute('data-tip');
    if (!text) return hide();
    const el = bubble();
    el.textContent = text;
    el.hidden = false;
    const r = host.closest('[role="menuitem"]')?.getBoundingClientRect() ?? host.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.top - h - 8;
    if (top < 8) top = r.bottom + 8;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  };
  document.addEventListener('pointerover', (event) => {
    const host = hostOf(event.target);
    if (host) show(host);
    else hide();
  });
  document.addEventListener('pointerdown', hide);
  window.addEventListener('scroll', hide, true);
})();
</script>
${makersActionsHead}`
}

await rm(publicDir, { recursive: true, force: true })
await mkdir(publicDir, { recursive: true })
await cp(webDist, publicDir, { recursive: true })
const { rows: entries, sources } = await clientPackages()
if (entries.length < 30) throw new Error(`Expected the DSH Web roster, found only ${String(entries.length)} bundles.`)
if (!sources.has(CLIENT_MODULES_ID)) throw new Error(`Expected ${CLIENT_MODULES_ID} in the DSH Web roster.`)
const bootstrapIds = [CLIENT_MODULES_ID]
const applicationIds = entries.map((entry) => entry.id).filter((id) => id !== CLIENT_MODULES_ID)
const batches = [
  await writeComboBatch('bootstrap', bootstrapIds, sources),
  await writeComboBatch('application', applicationIds, sources),
]
const graph = {
  rev: hash(JSON.stringify({ entries, batches })),
  entries,
  batches,
}
const shellHtml = await readFile(join(webDist, 'index.html'), 'utf8')
const headWithCharset = '<head>\n    <meta charset="utf-8" />'
if (!shellHtml.includes(headWithCharset)) {
  throw new Error('Published DSH Web index.html no longer declares charset as the first <head> child.')
}
// Keep charset first so the HTML5 encoding sniff (first 1024 bytes) sees UTF-8
// before the overlay script's Chinese copy. Injecting before charset made first
// paint mojibake until a reload remembered UTF-8.
const html = shellHtml
  .replace(headWithCharset, `${headWithCharset}${makersBootstrap(graph)}`)
  .replace('</body>', '<script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()<\/script></body>')
await writeFile(join(root, 'index.html'), html)
await writeFile(join(publicDir, 'index.html'), html)
console.log(`Prepared DSH Web ${graph.rev} with ${String(entries.length)} client plugins.`)
