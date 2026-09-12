function formatDriveSearchHit(file, scope, query) {
  const fileName = String((file && file.name) || '').trim() || 'קובץ Drive';
  const qNorm = stableNormalize(query);
  const nameNorm = stableNormalize(fileName);
  const nameHit = Boolean(qNorm && nameNorm && nameNorm.indexOf(qNorm) >= 0);
  const catalogTopic = scope.catalogTopic || 'כללי';
  const folderParts = Array.isArray(scope.path) ? scope.path.slice() : [];
  const locationPath = formatDriveLocationPath(folderParts);
  const pathLabels = folderParts.concat(fileName).join(' / ');
  const locationPathWithFile = formatDriveLocationPath(folderParts.concat(fileName));
  const gradeId = String(scope.gradeId || '');
  const gradeLabel = pedagogicalScope.GRADE_LABEL_BY_ID[gradeId] || '';
  const webViewLink = buildDriveFileUrl(file);

  return {
    id: 'drive:' + file.id,
    source: 'drive',
    driveFileId: file.id,
    title: fileName,
    displayTitle: fileName,
    topic: catalogTopic,
    subject: catalogTopic,
    catalogTopic: catalogTopic,
    bundleTopic: catalogTopic,
    gradeId: gradeId,
    grade_level: gradeId,
    gradeLabel: gradeLabel,
    fileName: fileName,
    filePath: pathLabels,
    pathLabels: pathLabels,
    drivePath: pathLabels,
    locationPath: locationPath || (gradeLabel && catalogTopic ? (gradeLabel + ' > ' + catalogTopic) : ''),
    locationPathWithFile: locationPathWithFile,
    fileUrl: webViewLink,
    webViewLink: webViewLink,
    mimeType: String((file && file.mimeType) || ''),
    resourceKey: String((file && file.resourceKey) || '').trim(),
    modifiedTime: String((file && file.modifiedTime) || ''),
    similarity: nameHit ? 0.95 : 0.88,
    matchType: nameHit ? 'drive_name' : 'drive_fulltext',
    matchedInBundle: Boolean(catalogTopic && stableNormalize(catalogTopic) !== nameNorm),
    alertText: catalogTopic
      ? ('נמצא חומר בתיקיית «' + catalogTopic + '» ב-Google Drive')
      : '',
  };
}