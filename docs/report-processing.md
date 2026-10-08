# Report processing

## Reviewed imports

Uploads create an admin-only draft with protected proof images. Standings change only after an admin reviews the extracted cells and confirms. Required cells must be corrected; optional cells can remain blank.

Pending drafts can be reopened, saved, compared with the original extraction, or discarded. They expire 24 hours after extraction; saving does not extend expiry. Saves, discards, and confirmations require the current `revision` to reject stale tabs.

Confirmation revalidates the competition schema, report dates, values, and current baselines in one SQLite `IMMEDIATE` transaction, then consumes the draft token exactly once. Cleanup runs at startup and every minute, invalidates expired drafts before removing files, retries failed deletions, and retains confirmed proofs. See [draft lifecycle details](review-proposals.md#11-draft-lifecycle).

## Image preparation

Uploads and sample discovery share a preview and processing pipeline. Images are limited to 5 MB and 40 megapixels; extraction times out after 60 seconds.

Processing applies EXIF orientation, the chosen 0/90/180/270-degree rotation, then an optional crop. Originals remain unchanged. Confirmed uploads retain the processed PNG and JSON processing metadata alongside the original proof; draft review links to both images. Expired/discarded draft cleanup removes all three artifacts.

### Orientation

Selecting an image runs local Tesseract OSD after EXIF normalization. A confidence margin of at least 15 updates the preview automatically; weaker results offer a suggestion, and conflicting readings require review. Missing support, sparse text, or timeouts leave manual rotation available.

Detection uses temporary copies, including adaptive thresholding and page-region retries. It does not alter stored proofs or call the vision provider. The server runs one detector at a time with a 15-second retry budget. Manual rotation or image replacement cancels pending suggestions; extraction uses the chosen rotation without detecting again.

See [setup](setup.md) for Tesseract installation.

### Cropping

Choose **Crop report** to drag the selection or its corners, or enter percentages. Arrow keys move the focused selection or resize a corner; Shift uses larger steps. **Apply crop** retains the selected region, **Cancel crop** restores the previous selection, and **Reset crop** restores the full image. Keep headers, timestamps, report dates, and every participant row.

Scanning waits until the editor closes. Starting a crop cancels pending orientation detection; rotation or image replacement clears the crop. Crops are per image and independent of competition profiles.

Local page-boundary detection can suggest a rectangle around light paper on a contrasting background. **Review suggested crop** opens the editor; a suggestion never applies itself. Detection can decline ambiguous, clipped, low-contrast, or competing pages and does not correct perspective. Failure leaves manual cropping and scanning available.

API crops use `{x,y,width,height}` fractions of the EXIF-corrected, rotated full-resolution image. Browser and server share pixel-bound conversion. Processing metadata version 2 records normalized crop, pixel bounds, and pre/post-crop dimensions. Orientation detection uses the uncropped image.

## Extraction contract

`src/lib/vision-provider.ts` owns provider transport; `src/lib/vision.ts` separates schema discovery from extraction using approved metric keys. Report profiles store identifier/column aliases and date instructions independently of scoring, so heading changes usually need only a mapping update.

```json
{
  "contract_version": 1,
  "generated_at": "2026-09-27T22:11:00",
  "period_start": "2026-09-27",
  "period_end": "2026-09-27",
  "rows": [
    {
      "participant_id": "104",
      "values": { "metric_1": "-1.40", "metric_2": "-0.69" }
    }
  ]
}
```

Decimals are strings; unreadable fields are null and remain editable. Unknown keys/versions or incomplete responses fail extraction. Dates, precision, identifiers, and ordering are validated again on confirmation. Reports record schema/profile versions. New adapters must normalize to this contract; providers do not calculate standings or change configuration.

For competitions with **Track multiple items** enabled, extraction also returns a report-level `item_code` string or null. The header code identifies the item for every participant row; it is separate from participant identifiers and numeric metrics. Leading zeroes are preserved. Ambiguous headers, ranges, or multiple codes return null and require admin selection. Single-stream competitions do not request an item code.

Review displays the original detected code alongside the configured item selector. An unfamiliar code does not automatically create an item. **Add item to competition** validates a name and code, preserves the current draft edits and original extraction, advances its revision and schema version, and requires renewed review before confirmation. Other drafts become stale after this configuration change.

Transport uses `fetch`, base64 `image_url` content, and JSON mode. The requested prompt lives in `src/lib/vision.ts`; see the provider's [image input](https://developers.openai.com/api/docs/guides/images-vision?api-mode=chat) and [JSON mode](https://developers.openai.com/api/docs/guides/structured-outputs) references.
