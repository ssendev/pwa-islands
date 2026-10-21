# PWA Islands

Dies ist eine PWA welche dazu dient eine reihe von mini APPs zu speichern und zwichen mehreren browsern zu synchronisieren.

# Architektur

Dies ist eine minimale PWA in der kleine .html projekte mit FS API gespeichert werden und dann angezeigt werden können.

# UI

aller UI text MUSS in Deutsch geschrieben werden

# Befehle

`npm run -s build` prüft Formatierung und Lint und baut dann.
`npm run -s fix` runs `oxfmt` and `oxlint --fix` Code Formatieren und Linten.

# Islands-API

die .html projekte können die öffentliche API für Islands verwenden. Sie ist in `src/api-types.ts` definiert und wird mit `import islands from '/api.js'` eingebunden.
