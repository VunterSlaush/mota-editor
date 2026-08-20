/**
 * Ports layer — boundary for getting the user's attention when an agent
 * finishes while they're looking elsewhere. The adapter decides the
 * mechanics (OS notifications, focus detection); the core only states
 * what happened and whether the user was already watching that tab.
 */
export interface NotificationPort {
  /**
   * A turn completed in a project. `tabActive` tells whether that tab is
   * the one currently shown — implementations suppress the notification
   * when the user is demonstrably already looking at the result.
   */
  turnCompleted(
    projectName: string,
    providerName: string,
    tabActive: boolean,
  ): Promise<void>;

  /** A plain notification with caller-supplied text (extensions use
   *  this); same best-effort contract as `turnCompleted`. */
  show(title: string, body: string): Promise<void>;
}
