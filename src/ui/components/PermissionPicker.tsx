import { Lightning, PencilSimple, ShieldCheck } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { PERMISSIONS, type PermissionPolicy } from "../../core/entities/agentSettings";
import { OptionPicker, type PickerOption } from "./OptionPicker";

/**
 * Icons for the core's permission descriptors. They live here, not beside
 * the descriptors: the entities layer knows nothing of icons.
 */
const PERMISSION_ICONS: Record<PermissionPolicy, ReactNode> = {
  manual: <ShieldCheck />,
  auto: <PencilSimple />,
  bypass: <Lightning />,
};

const OPTIONS: readonly PickerOption<PermissionPolicy>[] = PERMISSIONS.map(
  (permission) => ({ ...permission, icon: PERMISSION_ICONS[permission.id] }),
);

interface Props {
  value: PermissionPolicy;
  disabled: boolean;
  onChange: (permission: PermissionPolicy) => void;
  /** Passed through. The defaults suit the composer toolbar. */
  placement?: "top" | "bottom";
}

/** UI — choose how much the agent may do without asking. */
export function PermissionPicker({
  value,
  disabled,
  onChange,
  placement = "top",
}: Props) {
  return (
    <OptionPicker
      ariaLabel="Permissions"
      options={OPTIONS}
      value={value}
      disabled={disabled}
      placement={placement}
      onChange={onChange}
    />
  );
}
