// Active public entry point. The v1 prompt remains in editor-prompt.ts for history.
export { EditorV2Agent as EditorAgent, createConfiguredEditorV2 as createConfiguredEditor, getEditorV2ModelConfig as getEditorModelConfig } from "./editor-v2-agent.ts";
export { editorV2AgentVersion as editorAgentVersion, editorV2SystemInstructions as editorSystemInstructions } from "./editor-v2-prompt.ts";
export type { EditorV2RunOptions as EditorRunOptions } from "./editor-v2-agent.ts";
export { editorInputSchema, editorModelInputSchema } from "./editor-types.ts";
export type { EditorInput, EditorModelInput } from "./editor-types.ts";
