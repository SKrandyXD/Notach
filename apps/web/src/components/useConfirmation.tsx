import { useCallback, useState } from "react";
import {
  ConfirmationDialog,
  type ConfirmationOptions,
} from "./ConfirmationDialog.js";

export function useConfirmation() {
  const [request, setRequest] = useState<ConfirmationOptions | null>(null);
  const confirm = useCallback((options: ConfirmationOptions) => {
    setRequest((current) => current ?? options);
  }, []);
  const close = useCallback(() => setRequest(null), []);
  const confirmation = request ? (
    <ConfirmationDialog {...request} onClose={close} />
  ) : null;
  return { confirm, confirmation };
}
