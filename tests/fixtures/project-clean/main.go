package main

import "fmt"

// This project uses current models only. Tokens like gpt-4o and gpt-4-turbo
// must NOT be flagged by the dataset entry for the bare base model ID:
// the matcher requires exact-token boundaries.
const model = "gpt-4o"
const backup = "gpt-4-turbo"

func main() {
	fmt.Println("model:", model, "backup:", backup)
}
