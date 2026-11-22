package languages

import (
	"os"
	"strings"
)

// ImageTag is the tag of this stack's sandbox images, from JUDGE_IMAGE_TAG. Two stacks on one
// Docker host (production and testing on deploy2 and deploy4) both build judge-<lang>-env;
// under one shared tag, deploying either replaced the images the other's judge runs. The
// compose files default it to the Compose project name, so each stack builds and runs its
// own. Empty means the untagged name (latest), as before.
func ImageTag() string {
	return strings.TrimSpace(os.Getenv("JUDGE_IMAGE_TAG"))
}

// ImageRef is the image this judge creates the language's sandboxes from.
func (l *Language) ImageRef() string {
	if tag := ImageTag(); tag != "" && !strings.Contains(l.Image, ":") {
		return l.Image + ":" + tag
	}
	return l.Image
}
