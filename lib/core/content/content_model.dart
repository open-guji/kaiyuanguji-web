/// 内容数据模型
/// 用于表示从 Markdown 文件解析出的结构化内容
class ContentModel {
  /// 内容标题（从 Frontmatter 提取或使用文件名）
  final String title;

  /// 内容主体（Markdown 格式）
  final String content;

  /// 元数据（可选，从 Frontmatter 解析）
  final Map<String, dynamic>? metadata;

  /// 创建日期（可选）
  final DateTime? createdAt;

  /// 标签列表（可选）
  final List<String>? tags;

  const ContentModel({
    required this.title,
    required this.content,
    this.metadata,
    this.createdAt,
    this.tags,
  });

  /// 创建副本
  ContentModel copyWith({
    String? title,
    String? content,
    Map<String, dynamic>? metadata,
    DateTime? createdAt,
    List<String>? tags,
  }) {
    return ContentModel(
      title: title ?? this.title,
      content: content ?? this.content,
      metadata: metadata ?? this.metadata,
      createdAt: createdAt ?? this.createdAt,
      tags: tags ?? this.tags,
    );
  }
}
