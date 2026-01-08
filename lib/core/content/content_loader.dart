// ignore_for_file: avoid_print

import 'package:flutter/services.dart';

/// 内容加载服务
/// 负责从 assets 目录加载 Markdown 文件
class ContentLoader {
  /// 从 assets 加载指定路径的文件内容
  ///
  /// [path] 文件路径，相对于 assets 目录
  /// 例如：'content/chapter_1.md'
  ///
  /// 返回文件的字符串内容
  /// 如果文件不存在或加载失败，抛出异常
  static Future<String> loadAsset(String path) async {
    try {
      // 确保路径以 'assets/' 开头
      final assetPath = path.startsWith('assets/') ? path : 'assets/$path';

      final content = await rootBundle.loadString(assetPath);
      return content;
    } catch (e) {
      throw Exception('加载文件失败: $path, 错误: $e');
    }
  }

  /// 从 assets/content 目录加载 Markdown 文件
  ///
  /// [filename] 文件名，不需要包含路径和扩展名
  /// 例如：'chapter_1' 会加载 'assets/content/chapter_1.md'
  ///
  /// 返回文件的字符串内容
  static Future<String> loadContent(String filename) async {
    // 自动添加 .md 扩展名（如果没有的话）
    final file = filename.endsWith('.md') ? filename : '$filename.md';
    return loadAsset('content/$file');
  }

}
