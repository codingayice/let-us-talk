import type { Character } from "@let-us-talk/shared";

export interface AvatarProvider {
  getUrl(seed: string): string;
}

/** The vendor is isolated here so IM components never depend on an avatar service. */
export const avatarProvider: AvatarProvider = {
  getUrl(seed) {
    return `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(seed)}`;
  },
};

export function avatarUrl(character: Pick<Character, "id">) {
  return avatarProvider.getUrl(character.id);
}
