/// Markdown 目录提取器
/// 从 Markdown 内容中提取标题结构，生成目录
class TocExtractor {
  // 禁止实例化
  TocExtractor._();

  /// 从 Markdown 内容中提取目录项
  static List<TocItem> extractToc(String markdown) {
    final items = <TocItem>[];
    final lines = markdown.split('\n');

    for (var i = 0; i < lines.length; i++) {
      final line = lines[i].trim();

      // 匹配 Markdown 标题 (# ## ### 等)
      final match = RegExp(r'^(#{1,6})\s+(.+)$').firstMatch(line);
      if (match != null) {
        final level = match.group(1)!.length; // 标题级别 (1-6)
        final title = match.group(2)!.trim();

        // 移除标题中的 Markdown 格式（如加粗、链接等）
        final cleanTitle = _cleanMarkdownFormatting(title);

        items.add(TocItem(
          title: cleanTitle,
          level: level,
          index: i,
        ));
      }
    }

    return items;
  }

  /// 清理标题中的 Markdown 格式
  static String _cleanMarkdownFormatting(String text) {
    String result = text;

    // 移除加粗 **text** 或 __text__
    result = result.replaceAll(RegExp(r'\*\*(.+?)\*\*'), r'$1');
    result = result.replaceAll(RegExp(r'__(.+?)__'), r'$1');

    // 移除斜体 *text* 或 _text_
    result = result.replaceAll(RegExp(r'\*(.+?)\*'), r'$1');
    result = result.replaceAll(RegExp(r'_(.+?)_'), r'$1');

    // 移除链接 [text](url)
    result = result.replaceAll(RegExp(r'\[(.+?)\]\(.+?\)'), r'$1');

    // 移除行内代码 `code`
    result = result.replaceAll(RegExp(r'`(.+?)`'), r'$1');

    // 移除删除线 ~~text~~
    result = result.replaceAll(RegExp(r'~~(.+?)~~'), r'$1');

    return result.trim();
  }
}

/// 目录项数据模型
class TocItem {
  /// 标题文本
  final String title;

  /// 标题级别 (1-6 对应 h1-h6)
  final int level;

  /// 在原始 Markdown 中的行索引
  final int index;

  const TocItem({
    required this.title,
    required this.level,
    required this.index,
  });

  @override
  String toString() => 'TocItem(title: $title, level: $level, index: $index)';
}
