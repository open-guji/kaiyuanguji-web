import 'dart:convert';
import 'package:http/http.dart' as http;
import 'book_index_model.dart';

/// 古籍索引服务
/// 从 GitHub 仓库获取古籍数据
class BookIndexService {
  static const String _baseApiUrl = 'https://api.github.com/repos/open-guji';

  /// 获取所有古籍列表（合并正式版和草稿版）
  static Future<List<BookIndexItem>> fetchAllBooks() async {
    final List<BookIndexItem> allItems = [];

    // 获取草稿版（目前主要数据在这里）
    final draftItems = await _fetchBooksFromRepo('book-index-draft', isDraft: true);
    allItems.addAll(draftItems);

    // 获取正式版
    final officialItems = await _fetchBooksFromRepo('book-index', isDraft: false);
    allItems.addAll(officialItems);

    return allItems;
  }

  /// 从指定仓库获取书籍列表
  static Future<List<BookIndexItem>> _fetchBooksFromRepo(
    String repoName, {
    required bool isDraft,
  }) async {
    final List<BookIndexItem> items = [];

    // 遍历三种类型的目录
    for (final typeDir in ['Book', 'Work', 'Collection']) {
      try {
        final typeItems = await _fetchItemsRecursively(
          repoName,
          typeDir,
          isDraft: isDraft,
        );
        items.addAll(typeItems);
      } catch (e) {
        // 目录可能不存在，忽略错误
      }
    }

    return items;
  }

  /// 递归获取目录下的所有 .md 文件
  static Future<List<BookIndexItem>> _fetchItemsRecursively(
    String repoName,
    String path, {
    required bool isDraft,
  }) async {
    final List<BookIndexItem> items = [];
    final url = '$_baseApiUrl/$repoName/contents/$path';

    try {
      final response = await http.get(
        Uri.parse(url),
        headers: {'Accept': 'application/vnd.github.v3+json'},
      );

      if (response.statusCode != 200) {
        return items;
      }

      final List<dynamic> contents = json.decode(response.body);

      for (final item in contents) {
        final String itemName = item['name'];
        final String itemPath = item['path'];
        final String itemType = item['type'];

        if (itemType == 'file' && itemName.endsWith('.md')) {
          // 排除模板文件
          if (!itemPath.contains('template')) {
            items.add(BookIndexItem.fromGitHubFile(
              name: itemName,
              path: itemPath,
              isDraft: isDraft,
            ));
          }
        } else if (itemType == 'dir') {
          // 递归获取子目录
          final subItems = await _fetchItemsRecursively(
            repoName,
            itemPath,
            isDraft: isDraft,
          );
          items.addAll(subItems);
        }
      }
    } catch (e) {
      // 网络错误，返回空列表
    }

    return items;
  }

  /// 根据ID查找古籍
  static Future<BookIndexItem?> findBookById(String id) async {
    final allBooks = await fetchAllBooks();
    try {
      return allBooks.firstWhere((item) => item.id == id);
    } catch (e) {
      return null;
    }
  }

  /// 搜索古籍（按名称）
  static Future<List<BookIndexItem>> searchBooks(String query) async {
    if (query.isEmpty) {
      return fetchAllBooks();
    }

    final allBooks = await fetchAllBooks();
    final lowerQuery = query.toLowerCase();

    return allBooks.where((item) {
      return item.name.toLowerCase().contains(lowerQuery) ||
          item.id.toLowerCase().contains(lowerQuery);
    }).toList();
  }

  /// 获取古籍的 Markdown 内容
  static Future<String> fetchBookContent(BookIndexItem item) async {
    try {
      final response = await http.get(Uri.parse(item.rawUrl));
      if (response.statusCode == 200) {
        return utf8.decode(response.bodyBytes);
      }
      throw Exception('Failed to load content: ${response.statusCode}');
    } catch (e) {
      throw Exception('Failed to fetch book content: $e');
    }
  }

  /// 根据ID直接获取内容（用于详情页）
  static Future<String> fetchContentById(String id) async {
    final item = await findBookById(id);
    if (item == null) {
      throw Exception('Book not found: $id');
    }
    return fetchBookContent(item);
  }
}
