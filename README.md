# UniFiles Converter +*!¡

A desktop app (and command-line tool) to convert images, videos, audio files, documents, and spreadsheets between various formats.

## Desktop App

**Install it:** download `UniFiles-Converter-Setup-x.x.x.exe` from the [latest release](https://github.com/lucasboschiroli/UniFiles_Converter/releases/latest) and run it. Everything it needs (including ffmpeg) is built in, so Python isn't needed, and the app updates itself when a new version is released.

**Use it:**
1. Drop files (or a whole folder) anywhere on the window, or press **Add files** / **Add folder**. You can mix images, videos, audio, documents and spreadsheets.
2. Each file gets a sensible target format. Change one in its row, or use **Convert all** to set every image, video, etc. at once.
3. Optionally open **Options** for image quality and size, video quality and resolution, and audio quality. When several images go to PDF, **Combine into one PDF** puts them in a single file.
4. Choose where to save: **next to the original** (default) or a folder. Existing files are never overwritten: you get `photo (1).jpg` instead.
5. Press **Convert**. Each row shows its progress, and finished rows get **Open** and **Show** buttons. **Cancel** stops right away and removes any half-written file.

| From | To |
|---|---|
| Images: JPG, PNG, WebP, AVIF, GIF, TIFF, BMP, ICO, SVG | JPG, PNG, WebP, AVIF, GIF, TIFF, BMP, ICO (multi-size), PDF, CBZ |
| Video: MP4, MOV, MKV, WebM, AVI, WMV, FLV, MPEG, 3GP, TS | MP4, WebM, MKV, MOV, AVI, GIF, or audio only (MP3, M4A, WAV, FLAC, OGG, Opus) |
| Audio: MP3, WAV, OGG, FLAC, M4A, AAC, WMA, Opus, AIFF | MP3, WAV, OGG, FLAC, M4A, AAC, Opus |
| PDF | Word (DOCX), TXT, EPUB, CBZ, or one PNG/JPG per page |
| Word (DOCX) | PDF, TXT, HTML, EPUB, AZW3\*, MOBI\* |
| TXT, Markdown | PDF, Word, EPUB, AZW3\*, MOBI\* |
| HTML | PDF, TXT, EPUB, AZW3\*, MOBI\* |
| Ebooks: EPUB, FB2, AZW3\*, MOBI\* | EPUB, AZW3\*, MOBI\*, PDF, Word, TXT, HTML |
| Comics: CBZ, CBR | CBZ, CBR\*\*, PDF, EPUB (fixed layout), or a folder with every page as a picture |
| Spreadsheets: XLSX, XLS, ODS, CSV, TSV | XLSX, CSV (one per sheet), ODS, PDF, HTML |

\* Kindle formats (AZW3, MOBI) need the free [Calibre](https://calibre-ebook.com/download_windows) app installed; the app finds it automatically (press **Check again** after installing). Everything else works on its own.
\*\* Creating CBR (RAR) files needs WinRAR, because RAR is a closed format. Reading CBR always works, and CBZ opens in every comic reader.

> PDF → Word keeps the text, headings and paragraphs, not the exact layout or images. Scanned PDFs have no text to extract; convert them to PNG/JPG instead.
> DRM-protected (copy-protected) ebooks can't be converted.
> Several pictures can become one comic: set them to CBZ with **Combine into one PDF or CBZ** on.

**Run it from source:**
```bash
npm install
npm start
```

**Build the installer:** `npm run dist` (the installer is created in `dist/`).

**Publish a new version:**
1. Raise `"version"` in `package.json` and commit.
2. `git tag v1.0.1 && git push origin main --tags`
3. GitHub Actions (`.github/workflows/release.yml`) bundles ffmpeg, builds the installer and publishes the release. Installed apps update themselves.

## Command-Line Tool

The original Python script, `converter.py`, still works on its own.

## Features

- **Multi-format image conversion**: JPG, PNG, GIF, BMP, TIFF, WEBP, ICO
- **Video conversion**: MP4, AVI, MKV, MOV, WEBM, GIF
- **Audio conversion**: MP3, WAV, OGG, FLAC, M4A, AAC
- **Document conversion**: PDF, DOCX, TXT
- **Excel conversion**: XLS, XLSX
- **Batch processing**: Convert entire folders at once
- **High-quality output**: Preserves quality during conversion
- **Auto-detection**: Automatically detects file types
- **Simple interface**: Easy-to-use command-line tool

## Prerequisites

- Python 3.7 or higher
- ffmpeg (required for video/audio conversion)
- Pillow (required for image conversion)
- python-docx (required for DOCX conversion)
- PyPDF2 (required for PDF conversion)
- PyMuPDF (required for PDF to DOCX conversion)
- reportlab (required for TXT to PDF conversion)
- openpyxl (required for Excel conversion)
- xlrd (only needed to read old .xls files)
- docx2pdf (only needed for DOCX to PDF; it uses Microsoft Word)

## Installation

1. **Clone or download this repository**

2. **Install required Python packages:**
   
   **For images, videos, and audio:**
   ```bash
   pip install Pillow
   ```
   
   **For document conversion:**
   ```bash
   pip install python-docx PyPDF2 PyMuPDF reportlab docx2pdf
   ```
   
   **For Excel conversion:**
   ```bash
   pip install openpyxl xlrd
   ```
   
   **Or install everything at once:**
   ```bash
   pip install Pillow python-docx PyPDF2 PyMuPDF reportlab docx2pdf openpyxl xlrd
   ```

3. **Install ffmpeg (required for video/audio):**
   
   **Windows:**
   ```bash
   winget install ffmpeg
   ```
   
   **macOS:**
   ```bash
   brew install ffmpeg
   ```
   
   **Linux:**
   ```bash
   sudo apt install ffmpeg
   ```

## Usage

### Convert a single file

```bash
python converter.py <input_file> <output_format>
```

### Batch convert multiple files

```bash
python converter.py --batch <directory> <output_format>
```

## Examples

```bash
# Convert image formats
python converter.py photo.png jpg
python converter.py image.jpg webp

# Convert video formats
python converter.py video.mp4 webm
python converter.py movie.avi mkv
python converter.py clip.mp4 gif

# Convert audio formats
python converter.py song.wav mp3
python converter.py audio.flac ogg

# Convert documents
python converter.py document.docx pdf
python converter.py file.pdf txt
python converter.py notes.txt docx

# Convert Excel files
python converter.py spreadsheet.xls xlsx
python converter.py data.xlsx csv
python converter.py data.csv xlsx

# Batch convert all files in a folder
python converter.py --batch ./my_images png
python converter.py --batch ./videos mp4
python converter.py --batch ./documents pdf
```

## Output

Converted files are saved next to the original file with the new extension. If a file with that name already exists, a number is added (`photo (1).jpg`) instead of overwriting it. Batch mode only converts files that can become the requested format and skips ones already in it.

## Troubleshooting

### "pip is not recognized"
Use `python -m pip install <package>` instead

### "ffmpeg is not installed"
Install ffmpeg using the instructions above. Required for video and audio conversions.

### "Module not found" errors
Install the missing package:
- Images: `pip install Pillow`
- Documents: `pip install python-docx PyPDF2 PyMuPDF reportlab docx2pdf`
- Excel: `pip install openpyxl xlrd`

### Conversion fails
- Check that the input file exists and is not corrupted
- Verify the output format is supported for that file type
- Some document conversions may require additional system dependencies

### Python 3.14 compatibility issues
If you encounter build errors with newer Python versions, try:
```bash
pip install --only-binary :all: <package_name>
```

## Supported Conversions

### Images
JPG ↔ PNG ↔ GIF ↔ BMP ↔ TIFF ↔ WEBP ↔ ICO

### Videos
MP4 ↔ AVI ↔ MKV ↔ MOV ↔ WEBM ↔ GIF

### Audio
MP3 ↔ WAV ↔ OGG ↔ FLAC ↔ M4A ↔ AAC

### Documents
- PDF → DOCX, TXT
- DOCX → PDF, TXT
- TXT → PDF, DOCX

### Excel
- XLS → XLSX
- XLSX ↔ CSV

## Legal Notice

This tool is for personal use. Please respect copyright laws and only convert files you have the right to modify.

## License

© 2025 Lucas Salomão Boschiroli. All rights reserved. Free to use for personal, non-commercial purposes; the code may not be copied, modified, redistributed or sold without permission. See [LICENSE](LICENSE).

## Credits

Built with:
- [Pillow](https://python-pillow.org/) - Image processing
- [FFmpeg](https://ffmpeg.org/) - Video and audio conversion
- [python-docx](https://python-docx.readthedocs.io/) - Word document processing
- [PyPDF2](https://pypdf2.readthedocs.io/) - PDF processing
- [ReportLab](https://www.reportlab.com/) - PDF generation
- [openpyxl](https://openpyxl.readthedocs.io/) - Excel file processing
