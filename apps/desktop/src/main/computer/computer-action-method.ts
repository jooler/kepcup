/** provider 动作方法（click / performSecondaryAction / … / setValue）。 */
export type ComputerActionMethod =
  | 'click'
  | 'performSecondaryAction'
  | 'scroll'
  | 'drag'
  | 'typeText'
  | 'pressKey'
  | 'hotkey'
  | 'pasteText'
  | 'setValue'
