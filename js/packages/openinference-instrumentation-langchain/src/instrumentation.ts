import type * as CallbackManagerModule from "@langchain/core/callbacks/manager";
import {
  InstrumentationBase,
  InstrumentationConfig,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
  isWrapped,
} from "@opentelemetry/instrumentation";
import { VERSION } from "./version";
import { Tracer, diag } from "@opentelemetry/api";
import { LangChainTracer } from "./tracer";

const MODULE_NAME = "@langchain/core/callbacks";

/**
 * Flag to check if the openai module has been patched
 * Note: This is a fallback in case the module is made immutable (e.x. Deno, webpack, etc.)
 */
let _isOpenInferencePatched = false;

/**
 * function to check if instrumentation is enabled / disabled
 */
export function isPatched() {
  return _isOpenInferencePatched;
}

export class LangChainInstrumentation extends InstrumentationBase<
  typeof CallbackManagerModule
> {
  constructor(config?: InstrumentationConfig) {
    super(
      "@arizeai/openinference-instrumentation-langchain",
      VERSION,
      Object.assign({}, config),
    );
  }

  manuallyInstrument(module: typeof CallbackManagerModule) {
    diag.debug(`Manually instrumenting ${MODULE_NAME}`);
    this.patch(module);
  }

  protected init(): InstrumentationModuleDefinition<
    typeof CallbackManagerModule
  > {
    const module = new InstrumentationNodeModuleDefinition<
      typeof CallbackManagerModule
    >(
      "@langchain/core/dist/callbacks/manager.cjs",
      ["^0.1.0"],
      this.patch.bind(this),
      this.unpatch.bind(this),
    );
    return module;
  }

  private patch(
    module: typeof CallbackManagerModule & {
      openInferencePatched?: boolean;
    },
    moduleVersion?: string,
  ) {
    diag.debug(
      `Applying patch for ${MODULE_NAME}${
        moduleVersion != null ? `@${moduleVersion}` : ""
      }`,
    );
    if (module?.openInferencePatched || _isOpenInferencePatched) {
      return module;
    }
    this.tracer;

    this._wrap(module.CallbackManager, "configure", (original) => {
      return (...args: Parameters<typeof original>) => {
        const inheritableHandlers = args[0];
        const newInheritableHandlers = addTracerToHandlers(
          this.tracer,
          inheritableHandlers,
        );
        args[0] = newInheritableHandlers;
        return original.apply(this, args);
      };
    });
    _isOpenInferencePatched = true;
    try {
      // This can fail if the module is made immutable via the runtime or bundler
      module.openInferencePatched = true;
    } catch (e) {
      diag.warn(`Failed to set ${MODULE_NAME} patched flag on the module`, e);
    }

    return module;
  }

  private unpatch(
    module?: typeof CallbackManagerModule & {
      openInferencePatched?: boolean;
    },
    moduleVersion?: string,
  ) {
    if (module == null) {
      return;
    }
    diag.debug(
      `Removing patch for ${MODULE_NAME}${
        moduleVersion != null ? `@${moduleVersion}` : ""
      }`,
    );
    if (isWrapped(module.CallbackManager.configure)) {
      this._unwrap(module.CallbackManager, "configure");
    }
    _isOpenInferencePatched = false;
    try {
      // This can fail if the module is made immutable via the runtime or bundler
      module.openInferencePatched = false;
    } catch (e) {
      diag.warn(`Failed to unset ${MODULE_NAME} patched flag on the module`, e);
    }
    return module;
  }
}

function addTracerToHandlers(
  tracer: Tracer,
  handlers?: CallbackManagerModule.Callbacks,
) {
  if (handlers == null) {
    return [new LangChainTracer(tracer)];
  }
  if (Array.isArray(handlers)) {
    const newHandlers = handlers;
    const tracerAlreadyRegistered = newHandlers.some(
      (handler) => handler instanceof LangChainTracer,
    );
    if (!tracerAlreadyRegistered) {
      newHandlers.push(new LangChainTracer(tracer));
    }
    return newHandlers;
  }
  const tracerAlreadyRegistered = handlers.inheritableHandlers.some(
    (handler) => handler instanceof LangChainTracer,
  );
  if (tracerAlreadyRegistered) {
    return handlers;
  }
  handlers.addHandler(new LangChainTracer(tracer), true);
  return handlers;
}
