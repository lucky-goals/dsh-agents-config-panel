export interface TeamMember {
  name: string;
  role?: string;
  provider?: string;
  model?: string;
  reasoning_effort?: string;
  [key: string]: unknown;
}

/** Member fields a patch may clear by sending `null`. */
export const CLEARABLE_MEMBER_FIELDS = ['role', 'provider', 'model', 'reasoning_effort'] as const;

/**
 * updateMember patch: a value sets the field, `null` deletes a clearable
 * field, and an omitted/undefined key leaves it unchanged.
 */
export type TeamMemberPatch = {
  [K in keyof TeamMember]?: TeamMember[K] | null;
};

export type MembersEditorResult =
  | { yamlText: string; error?: never }
  | { yamlText?: never; error: string };
