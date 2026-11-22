package languages

import "testing"

func TestImageRef(t *testing.T) {
	py := GetLanguage("python")

	t.Setenv("JUDGE_IMAGE_TAG", "")
	if got := py.ImageRef(); got != "judge-py-env" {
		t.Fatalf("no tag: got %q", got)
	}

	t.Setenv("JUDGE_IMAGE_TAG", " examportal-go-judge-ifal7h ")
	if got := py.ImageRef(); got != "judge-py-env:examportal-go-judge-ifal7h" {
		t.Fatalf("tag: got %q", got)
	}

	// TypeScript runs in the JavaScript image, under the same tag.
	if got := GetLanguage("typescript").ImageRef(); got != "judge-js-env:examportal-go-judge-ifal7h" {
		t.Fatalf("typescript: got %q", got)
	}
}
