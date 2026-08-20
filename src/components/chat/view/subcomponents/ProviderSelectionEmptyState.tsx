import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";

import type {
  ProjectSession,
  LLMProvider,
  ProviderModelsDefinition,
} from "../../../../types/app";
import { recordFeatureUse } from "../../../../utils/featureUsage";
import SessionProviderLogo from "../../../llm-logo-provider/SessionProviderLogo";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  Card,
} from "../../../../shared/view/ui";

const PROVIDER_META: { id: LLMProvider; name: string }[] = [
  { id: "claude", name: "Anthropic" },
  { id: "codex", name: "OpenAI" },
  { id: "antigravity", name: "Google" },
];

const MOD_KEY =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

// cmdk's default filter is fuzzy (loose character-subsequence scoring), which
// surfaces unrelated models — e.g. searching "chatgpt" also matched "Fable".
// Require every whitespace-separated search token to appear as a literal
// substring instead, so "claude 4.5" still matches "Anthropic Claude Haiku 4.5"
// but "chatgpt" only matches models that actually contain it.
function modelSearchFilter(value: string, search: string): number {
  const haystack = value.toLowerCase();
  const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.every((token) => haystack.includes(token)) ? 1 : 0;
}

type ProviderSelectionEmptyStateProps = {
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setProvider: (next: LLMProvider) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  claudeModel: string;
  setClaudeModel: (model: string) => void;
  codexModel: string;
  setCodexModel: (model: string) => void;
  antigravityModel: string;
  setAntigravityModel: (model: string) => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelsLoading: boolean;
};

type ProviderGroup = {
  id: LLMProvider;
  name: string;
  models: { value: string; label: string; description?: string }[];
};

function getModelConfig(
  p: LLMProvider,
  catalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>,
): ProviderModelsDefinition {
  const entry = catalog[p];
  return entry ?? { OPTIONS: [], DEFAULT: "" };
}

function getCurrentModel(
  p: LLMProvider,
  c: string,
  co: string,
  ag: string,
) {
  if (p === "codex") return co;
  if (p === "antigravity") return ag;
  return c;
}

function getProviderDisplayName(p: LLMProvider) {
  if (p === "codex") return "Codex";
  if (p === "antigravity") return "Antigravity";
  return "Claude";
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.(query).matches === true,
  );

  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return undefined;

    const update = () => setMatches(list.matches);
    update();
    list.addEventListener?.("change", update);
    return () => list.removeEventListener?.("change", update);
  }, [query]);

  return matches;
}

/**
 * Is the primary pointer a finger? Governs whether opening a picker should
 * summon the keyboard.
 */
function useCoarsePointer() {
  return useMediaQuery("(pointer: coarse)");
}

/**
 * Does the device have ANY precise pointer — a mouse, trackpad or stylus?
 *
 * Deliberately not `(pointer: coarse)`, which only describes the *primary*
 * pointer. iPadOS reports `pointer: coarse` even with a Magic Keyboard attached,
 * so keying a keyboard-shortcut hint off that would hide it from the single most
 * common touch-plus-keyboard device — a user who can actually press the
 * shortcut. `any-pointer: fine` is true there, and false on a plain phone.
 *
 * The picker's autofocus above can keep using the primary-pointer query: getting
 * that wrong only costs a tap, whereas this decides whether a capability is
 * discoverable at all.
 */
function useHasFinePointer() {
  return useMediaQuery("(any-pointer: fine)");
}

export default function ProviderSelectionEmptyState({
  selectedSession,
  currentSessionId,
  provider,
  setProvider,
  textareaRef,
  claudeModel,
  setClaudeModel,
  codexModel,
  setCodexModel,
  antigravityModel,
  setAntigravityModel,
  providerModelCatalog,
  providerModelsLoading,
}: ProviderSelectionEmptyStateProps) {
  const { t } = useTranslation("chat");
  const [dialogOpen, setDialogOpen] = useState(false);
  const isCoarsePointer = useCoarsePointer();
  const hasFinePointer = useHasFinePointer();

  const visibleProviderGroups = useMemo<ProviderGroup[]>(() => {
    return PROVIDER_META.map((p) => ({
      id: p.id,
      name: p.name,
      models: providerModelCatalog[p.id]?.OPTIONS ?? [],
    }));
  }, [providerModelCatalog]);

  const currentModel = getCurrentModel(
    provider,
    claudeModel,
    codexModel,
    antigravityModel,
  );

  const currentModelLabel = useMemo(() => {
    const config = getModelConfig(provider, providerModelCatalog);
    const found = config.OPTIONS.find(
      (o: { value: string; label: string }) => o.value === currentModel,
    );
    return found?.label || currentModel;
  }, [provider, currentModel, providerModelCatalog]);

  const setModelForProvider = useCallback(
    (providerId: LLMProvider, modelValue: string) => {
      if (providerId === "codex") {
        setCodexModel(modelValue);
        localStorage.setItem("codex-model", modelValue);
      } else if (providerId === "antigravity") {
        setAntigravityModel(modelValue);
        localStorage.setItem("antigravity-model", modelValue);
      } else {
        setClaudeModel(modelValue);
        localStorage.setItem("claude-model", modelValue);
      }
    },
    [setAntigravityModel, setClaudeModel, setCodexModel],
  );

  const handleModelSelect = useCallback(
    (providerId: LLMProvider, modelValue: string) => {
      // The pre-session picker; the in-session `/model` path is counted in
      // useChatProviderState.selectProviderModel.
      recordFeatureUse('chat.model_change');
      setProvider(providerId);
      localStorage.setItem("selected-provider", providerId);
      setModelForProvider(providerId, modelValue);
      setDialogOpen(false);
      setTimeout(() => textareaRef.current?.focus(), 100);
    },
    [setProvider, setModelForProvider, textareaRef],
  );

  if (!selectedSession && !currentSessionId) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <div className="w-full max-w-[34.25rem]">
          <div className="mb-8 text-center">
            <h2 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
              {t("providerSelection.title")}
            </h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {t("providerSelection.description")}
            </p>
          </div>

          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Card
                className="group mx-auto max-w-xs cursor-pointer border-border/60 transition-[transform,border-color,box-shadow] duration-fast hover:border-border hover:shadow-md active:scale-[0.99]"
                role="button"
                tabIndex={0}
              >
                <div className="flex items-center gap-2 p-3">
                  <SessionProviderLogo
                    provider={provider}
                    className="h-5 w-5 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1">
                      <span className="text-xs font-semibold text-foreground">
                        {getProviderDisplayName(provider)}
                      </span>
                      <span className="text-xs text-muted-foreground">·</span>
                      <span className="truncate text-xs text-foreground">
                        {currentModelLabel}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {t("providerSelection.clickToChange", {
                        defaultValue: "Click to change model",
                      })}
                    </p>
                  </div>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-y-0.5" />
                </div>
              </Card>
            </DialogTrigger>

            <DialogContent
              initialFocus={isCoarsePointer ? "container" : "first"}
              className="bottom-0 left-0 top-auto flex max-h-[85dvh] w-full max-w-none translate-x-0 translate-y-0 animate-none flex-col overflow-hidden rounded-b-none rounded-t-2xl p-0 sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:max-h-none sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:animate-dialog-content-show sm:rounded-xl"
            >
              <DialogTitle>Model Selector</DialogTitle>
              <div className="shrink-0 border-b border-border/60 bg-muted/20 px-4 py-3">
                <p className="text-sm font-semibold text-foreground">Choose a model</p>
              </div>
              <Command filter={modelSearchFilter} className="min-h-0 flex-1">
                <CommandInput
                  placeholder={t("providerSelection.searchModels", {
                    defaultValue: "Search models...",
                  })}
                />
                <CommandList className="max-h-none min-h-0 flex-1 overscroll-contain pb-safe-area-inset-bottom">
                  <CommandEmpty>
                    {t("providerSelection.noModelsFound", {
                      defaultValue: "No models found.",
                    })}
                  </CommandEmpty>
                  {visibleProviderGroups.map((group, idx) => (
                    <CommandGroup
                      key={group.id}
                      className={
                        idx > 0
                          ? "border-t border-border/40 [&_[cmdk-group-heading]]:mt-1 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                          : "[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                      }
                      heading={
                        <span className="flex items-center gap-1.5">
                          <SessionProviderLogo provider={group.id} className="h-3.5 w-3.5 shrink-0" />
                          {group.name}
                        </span>
                      }
                    >
                      {group.models.length === 0 && providerModelsLoading ? (
                        <CommandItem disabled className="ml-4 border-l border-border/40 pl-4 text-muted-foreground">
                          {t("providerSelection.loadingModels", { defaultValue: "Loading models…" })}
                        </CommandItem>
                      ) : null}
                      {group.models.map((model) => {
                        const isSelected = provider === group.id && currentModel === model.value;
                        return (
                          <CommandItem
                            key={`${group.id}-${model.value}`}
                            value={`${group.name} ${model.label} ${model.description || ''}`}
                            onSelect={() => handleModelSelect(group.id, model.value)}
                            className="ml-4 border-l border-border/40 pl-4"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="truncate">{model.label}</div>
                              {/* 
                              // * Temporarly commented out because the description of models from claude 
                              // * was a bit inconsistent.  Will return it back when it becomes more consistent.
                              */}
                              {/* {model.description && (
                                <div className="truncate text-xs text-muted-foreground">
                                  {model.description}
                                </div>
                              )} */}
                            </div>
                            {isSelected && (
                              <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />
                            )}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  ))}
                </CommandList>
              </Command>
            </DialogContent>
          </Dialog>

          <p className="mt-4 text-center text-sm text-muted-foreground/70">
            {
              {
                claude: t("providerSelection.readyPrompt.claude", {
                  model: claudeModel,
                }),
                codex: t("providerSelection.readyPrompt.codex", {
                  model: codexModel,
                }),
                antigravity: t("providerSelection.readyPrompt.antigravity", {
                  model: antigravityModel,
                }),
              }[provider]
            }
          </p>

          {/*
            Keyboard-only hint, so it is shown only where a precise pointer
            exists (#362). It advertised a shortcut a phone cannot press, and it
            was the only thing on this screen pointing at search — telling a
            touch user the feature exists while naming the one route they cannot
            take. It also spent a line of vertical space on the surface where
            space is tightest.

            Keyed off `any-pointer: fine` rather than the primary-pointer query
            used just above, so an iPad with a Magic Keyboard — which reports
            `pointer: coarse` even while a trackpad is attached — keeps the hint
            it can actually act on. Hiding is the whole fix here: giving touch
            users a tappable route into the palette is a separate, additive
            change that wants design review.
          */}
          {hasFinePointer && (
            <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground/60">
              <Trans
                ns="chat"
                i18nKey="providerSelection.pressToSearch"
                values={{ shortcut: MOD_KEY === "⌘" ? "⌘K" : "Ctrl+K" }}
                components={{
                  kbd: (
                    <kbd className="inline-flex items-center gap-0.5 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px]" />
                  ),
                }}
              />
            </p>
          )}
        </div>
      </div>
    );
  }

  if (selectedSession) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-[34.25rem] px-6 text-center">
          <p className="mb-1.5 text-lg font-semibold text-foreground">
            {t("session.continue.title")}
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("session.continue.description")}
          </p>
        </div>
      </div>
    );
  }

  return null;
}
