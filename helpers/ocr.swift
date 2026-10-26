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
do {
 guard CommandLine.arguments.count == 2 else { throw CocoaError(.fileReadInvalidFileName) }
 let url = URL(fileURLWithPath: CommandLine.arguments[1])
 let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max
 guard size <= 25 * 1024 * 1024 else { throw CocoaError(.fileReadTooLarge) }
 var parts: [String] = []
 if url.pathExtension.lowercased() == "pdf" {
  guard let document = PDFDocument(url: url), !document.isLocked else { throw CocoaError(.fileReadCorruptFile) }
  for i in 0..<min(document.pageCount, 2) {
   if let page = document.page(at: i) {
    let thumbnail = page.thumbnail(of: NSSize(width: 1600, height: 2200), for: .mediaBox)
    if let image = thumbnail.cgImage(forProposedRect: nil, context: nil, hints: nil) { parts.append(try recognize(image)) }
   }
  }
 } else {
  guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { throw CocoaError(.fileReadCorruptFile) }
  // A small file can still decode to gigabytes (PNG/TIFF); refuse absurd pixel counts before creating the thumbnail.
  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any]
  let width = properties?[kCGImagePropertyPixelWidth as String] as? Int ?? 0
  let height = properties?[kCGImagePropertyPixelHeight as String] as? Int ?? 0
  guard width > 0, height > 0, width <= 30_000, height <= 30_000, width * height <= 120_000_000 else { throw CocoaError(.fileReadTooLarge) }
  // WithTransform applies EXIF orientation; without it rotated phone photos are OCR'd sideways.
  guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways:true, kCGImageSourceCreateThumbnailWithTransform:true, kCGImageSourceThumbnailMaxPixelSize:2200] as CFDictionary)
  else { throw CocoaError(.fileReadCorruptFile) }
  parts.append(try recognize(image))
 }
 print(String(parts.joined(separator: "\n").prefix(6000)))
} catch {
 FileHandle.standardError.write(Data("ocr_failed\n".utf8)); exit(1)
}
