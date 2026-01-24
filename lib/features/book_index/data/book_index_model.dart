/// 资源类型枚举
enum BookResourceType {
  work, // 作品
  collection, // 丛编
  book, // 书
}

/// 古籍资源信息
class BookIndexItem {
  /// 唯一ID (如 CX8nMA93gxX)
  final String id;

  /// 名称
  final String name;

  /// 资源类型
  final BookResourceType type;

  /// 是否为草稿
  final bool isDraft;

  /// GitHub 原始文件路径
  final String rawPath;

  const BookIndexItem({
    required this.id,
    required this.name,
    required this.type,
    required this.isDraft,
    required this.rawPath,
  });

  /// 从 GitHub API 响应解析
  factory BookIndexItem.fromGitHubFile({
    required String name,
    required String path,
    required bool isDraft,
  }) {
    // 文件名格式: ID-名称.md
    final baseName = name.replaceAll('.md', '');
    final parts = baseName.split('-');
    final id = parts.first;
    final displayName = parts.length > 1 ? parts.sublist(1).join('-') : baseName;

    // 从路径推断类型
    BookResourceType type;
    if (path.startsWith('Work/')) {
      type = BookResourceType.work;
    } else if (path.startsWith('Collection/')) {
      type = BookResourceType.collection;
    } else {
      type = BookResourceType.book;
    }

    return BookIndexItem(
      id: id,
      name: displayName,
      type: type,
      isDraft: isDraft,
      rawPath: path,
    );
  }

  /// 获取类型的中文名称
  String get typeLabel {
    switch (type) {
      case BookResourceType.work:
        return '作品';
      case BookResourceType.collection:
        return '丛编';
      case BookResourceType.book:
        return '书';
    }
  }

  /// 获取状态标签
  String get statusLabel => isDraft ? '草稿' : '正式';

  /// 获取 GitHub 原始文件 URL
  String get rawUrl {
    final repo = isDraft ? 'book-index-draft' : 'book-index';
    return 'https://raw.githubusercontent.com/open-guji/$repo/main/$rawPath';
  }
}

/// 古籍索引列表响应
class BookIndexListResponse {
  final List<BookIndexItem> items;
  final bool hasMore;
  final String? nextCursor;

  const BookIndexListResponse({
    required this.items,
    this.hasMore = false,
    this.nextCursor,
  });
}
