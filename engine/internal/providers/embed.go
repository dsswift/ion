package providers

import (
	_ "embed"
)

//go:embed models.json
var modelCatalogJSON []byte
