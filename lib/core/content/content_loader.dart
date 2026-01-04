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

  /// 批量加载多个内容文件
  ///
  /// [filenames] 文件名列表
  /// 返回 Map，key 为文件名，value 为内容
  static Future<Map<String, String>> loadMultipleContents(
    List<String> filenames,
  ) async {
    final results = <String, String>{};

    for (final filename in filenames) {
      try {
        final content = await loadContent(filename);
        results[filename] = content;
      } catch (e) {
        // 记录错误但继续加载其他文件
        print('加载文件 $filename 失败: $e');
      }
    }

    return results;
  }

  /// 检查文件是否存在
  ///
  /// 注意：由于 Flutter 的限制，这个方法通过尝试加载文件来判断
  /// 如果文件不存在会返回 false
  static Future<bool> exists(String path) async {
    try {
      await loadAsset(path);
      return true;
    } catch (e) {
      return false;
    }
  }
}
