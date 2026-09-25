import { Lightning, PencilSimple, ShieldCheck, ShieldStar } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import {
  type PermissionPolicy,
  permissionsOffered,
} from "../../core/entities/agentSettings";
import { OptionPicker, type PickerOption } from "./OptionPicker";

/**
 * Icons for the core's permission descriptors. They live here, not beside
 * the descriptors: the entities layer knows nothing of icons.
 */
const PERMISSION_ICONS: Record<PermissionPolicy, ReactNode> = {
  manual: <ShieldCheck />,
  auto: <PencilSimple />,
  bypass: <Lightning />,
  "jev-auto": <ShieldStar />,
};

function optionsFor(jevGate: boolean): readonly PickerOption<PermissionPolicy>[] {
  return permissionsOffered(jevGate).map((permission) => ({
    ...permission,
    icon: PERMISSION_ICONS[permission.id],
  }));
}

const WITH_JEV = optionsFor(true);
const WITHOUT_JEV = optionsFor(false);

interface Props {
  value: PermissionPolicy;
  disabled: boolean;
  /** Whether Jev's gate runs — the only time "Auto with Jev" is offered. */
  jevGate: boolean;
  onChange: (permission: PermissionPolicy) => void;
  /** Passed through. The defaults suit the composer toolbar. */
  placement?: "top" | "bottom";
}

/** UI — choose how much the agent may do without asking. */
export function PermissionPicker({
  value,
  disabled,
  jevGate,
  onChange,
  placement = "top",
}: Props) {
  return (
    <OptionPicker
      ariaLabel="Permissions"
      options={jevGate ? WITH_JEV : WITHOUT_JEV}
      value={value}
      disabled={disabled}
      placement={placement}
      onChange={onChange}
    />
  );
}
