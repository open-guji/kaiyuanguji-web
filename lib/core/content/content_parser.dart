// ignore_for_file: avoid_print

import 'content_model.dart';

/// 内容解析器
/// 负责解析 Markdown 文件，提取 Frontmatter 和内容主体
class ContentParser {
  /// Frontmatter 的开始和结束标记
  static const String _frontmatterDelimiter = '---';

  /// 解析原始的 Markdown 文本为 ContentModel
  ///
  /// [rawContent] 原始文本内容
  /// [defaultTitle] 默认标题（当 Frontmatter 中没有 title 时使用）
  ///
  /// 支持的 Frontmatter 格式：
  /// ```
  /// ---
  /// title: 标题
  /// author: 作者
  /// date: 2024-01-01
  /// tags: [标签1, 标签2]
  /// ---
  /// ```
  static ContentModel parse(String rawContent, {String? defaultTitle}) {
    final parts = _extractFrontmatter(rawContent);
    final metadata = parts['metadata'] as Map<String, dynamic>?;
    final content = parts['content'] as String;

    return ContentModel(
      title: metadata?['title'] as String? ?? defaultTitle ?? '无标题',
      content: content,
      metadata: metadata,
      createdAt: metadata?['date'] != null
          ? _parseDate(metadata!['date'] as String)
          : null,
      tags: metadata?['tags'] != null ? _parseTags(metadata!['tags']) : null,
    );
  }

  /// 从文本中提取 Frontmatter 和内容
  ///
  /// 返回包含 'metadata' 和 'content' 的 Map
  static Map<String, dynamic> _extractFrontmatter(String rawContent) {
    final lines = rawContent.split('\n');

    // 检查是否以 --- 开头
    if (lines.isEmpty || lines.first.trim() != _frontmatterDelimiter) {
      return {'metadata': null, 'content': rawContent};
    }

    // 查找第二个 ---
    var endIndex = -1;
    for (var i = 1; i < lines.length; i++) {
      if (lines[i].trim() == _frontmatterDelimiter) {
        endIndex = i;
        break;
      }
    }

    // 如果没有找到结束标记，视为没有 Frontmatter
    if (endIndex == -1) {
      return {'metadata': null, 'content': rawContent};
    }

    // 提取 Frontmatter 部分
    final frontmatterLines = lines.sublist(1, endIndex);
    final metadata = _parseFrontmatterLines(frontmatterLines);

    // 提取内容部分（跳过第二个 --- 之后的空行）
    final contentLines = lines.sublist(endIndex + 1);
    final content = contentLines.join('\n').trim();

    return {'metadata': metadata, 'content': content};
  }

  /// 解析 Frontmatter 行为 Map
  static Map<String, dynamic> _parseFrontmatterLines(List<String> lines) {
    final metadata = <String, dynamic>{};

    for (final line in lines) {
      final trimmedLine = line.trim();
      if (trimmedLine.isEmpty) continue;

      // 查找第一个冒号
      final colonIndex = trimmedLine.indexOf(':');
      if (colonIndex == -1) continue;

      final key = trimmedLine.substring(0, colonIndex).trim();
      final value = trimmedLine.substring(colonIndex + 1).trim();

      metadata[key] = _parseValue(value);
    }

    return metadata;
  }

  /// 解析值（支持字符串、数组等）
  static dynamic _parseValue(String value) {
    // 去除引号
    var cleanValue = value;
    if ((cleanValue.startsWith('"') && cleanValue.endsWith('"')) ||
        (cleanValue.startsWith("'") && cleanValue.endsWith("'"))) {
      cleanValue = cleanValue.substring(1, cleanValue.length - 1);
    }

    // 检查是否是数组格式 [item1, item2]
    if (cleanValue.startsWith('[') && cleanValue.endsWith(']')) {
      final arrayContent = cleanValue.substring(1, cleanValue.length - 1);
      return arrayContent
          .split(',')
          .map((e) => e.trim())
          .where((e) => e.isNotEmpty)
          .toList();
    }

    return cleanValue;
  }

  /// 解析日期字符串
  static DateTime? _parseDate(String dateStr) {
    try {
      return DateTime.parse(dateStr);
    } catch (e) {
      print('日期解析失败: $dateStr, 错误: $e');
      return null;
    }
  }

  /// 解析标签（支持字符串或列表）
  static List<String>? _parseTags(dynamic tags) {
    if (tags is List) {
      return tags.map((e) => e.toString()).toList();
    } else if (tags is String) {
      return [tags];
    }
    return null;
  }

  /// 提取 Markdown 中的第一个标题作为默认标题
  ///
  /// 例如："# 标题" 会提取出 "标题"
  static String? extractFirstHeading(String content) {
    final lines = content.split('\n');
    for (final line in lines) {
      final trimmed = line.trim();
      if (trimmed.startsWith('#')) {
        // 移除所有 # 和空格
        return trimmed.replaceAll(RegExp(r'^#+\s*'), '').trim();
      }
    }
    return null;
  }
}
