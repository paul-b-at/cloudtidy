import Foundation
import Vision
import ImageIO
import PDFKit
import AppKit

func recognize(_ image: CGImage) throws -> String {
 let request = VNRecognizeTextRequest()
 request.recognitionLevel = .accurate
 request.recognitionLanguages = ["de-DE", "en-US"]
 try VNImageRequestHandler(cgImage: image).perform([request])
 return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}
/// A failed step: printed to stderr as `ocr_failed:<step>[:<code>]` — a fixed vocabulary plus numeric codes, never document content or paths.
struct Step: Error {
 let name: String; let code: String?
 init(_ name: String, _ error: Error? = nil) {
  self.name = name
  if let error = error { let e = error as NSError; code = "\(String(e.domain.filter { $0.isLetter || $0 == "." }.suffix(24))).\(e.code)" } else { code = nil }
 }
}
/// Below this many characters the PDF has no usable text layer (scan, image-only export) and the pages are OCR'd instead.
let minTextLayer = 30
do {
 guard CommandLine.arguments.count == 2 else { throw Step("usage") }
 let url = URL(fileURLWithPath: CommandLine.arguments[1])
 let size: Int
 do { size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max } catch { throw Step("stat", error) }
 guard size <= 25 * 1024 * 1024 else { throw Step("too_large") }
 var parts: [String] = []
 if url.pathExtension.lowercased() == "pdf" {
  guard let document = PDFDocument(url: url) else { throw Step("pdf_open") }
  guard !document.isLocked else { throw Step("locked") }
  let pages = (0..<min(document.pageCount, 2)).compactMap { document.page(at: $0) }
  // 1. The PDFKit text layer (exact, instant, no model). 2. Only when it is (nearly) empty: Vision OCR of the page thumbnails.
  let layer = pages.compactMap { $0.string?.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.joined(separator: "\n")
  if layer.count >= minTextLayer { parts.append(layer) }
  else {
   var failure: Step? = nil
   for page in pages {
    let thumbnail = page.thumbnail(of: NSSize(width: 1600, height: 2200), for: .mediaBox)
    guard let image = thumbnail.cgImage(forProposedRect: nil, context: nil, hints: nil) else { failure = failure ?? Step("cgimage"); continue }
    do { parts.append(try recognize(image)) } catch { failure = failure ?? Step("vision", error) }
   }
   // A page that failed is only an error when nothing at all could be read.
   if parts.isEmpty, let failure = failure { throw failure }
   if pages.isEmpty { throw Step("no_pages") }
  }
 } else {
  guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { throw Step("image_open") }
  // A small file can still decode to gigabytes (PNG/TIFF); refuse absurd pixel counts before creating the thumbnail.
  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any]
  let width = properties?[kCGImagePropertyPixelWidth as String] as? Int ?? 0
  let height = properties?[kCGImagePropertyPixelHeight as String] as? Int ?? 0
  guard width > 0, height > 0, width <= 30_000, height <= 30_000, width * height <= 120_000_000 else { throw Step("image_size") }
  // WithTransform applies EXIF orientation; without it rotated phone photos are OCR'd sideways.
  guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways:true, kCGImageSourceCreateThumbnailWithTransform:true, kCGImageSourceThumbnailMaxPixelSize:2200] as CFDictionary)
  else { throw Step("thumbnail") }
  do { parts.append(try recognize(image)) } catch { throw Step("vision", error) }
 }
 print(String(parts.joined(separator: "\n").prefix(6000)))
} catch {
 let step = error as? Step ?? Step("other", error)
 FileHandle.standardError.write(Data("ocr_failed:\(step.name)\(step.code.map { ":\($0)" } ?? "")\n".utf8)); exit(1)
}
