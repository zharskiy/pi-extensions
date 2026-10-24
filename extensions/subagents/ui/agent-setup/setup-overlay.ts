import type { FormFactory } from "../../../../pi-adapter/index.ts";
import { SCOPES, type Scope, type SetupChange } from "../../core/agent-setup/scope.ts";
import { initialSetup, pressSetupKey, type SetupContext, setupChanges } from "./form.ts";
import { renderSetup, type SetupPaths } from "./setup-render.ts";

export type SetupResult = { scope: Scope; changes: SetupChange[] };

export const setupForm =
  (context: SetupContext, paths: SetupPaths): FormFactory<SetupResult | undefined> =>
  (api) => {
    let state = initialSetup(context);

    return {
      render: (width) => renderSetup(context, state, paths, api.theme, width),
      handleKey: (key) => {
        const outcome = pressSetupKey(context, state, key);

        state = outcome.state;

        if (outcome.done === "cancel") {
          api.done(undefined);
          return;
        }

        if (outcome.done === "save") {
          api.done({ scope: SCOPES[state.scope] ?? "user", changes: setupChanges(context, state) });
          return;
        }

        api.requestRender();
      },
    };
  };
