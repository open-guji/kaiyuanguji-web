import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../../../core/content/content_loader.dart';
import '../../../../core/content/content_parser.dart';
import '../../../../core/content/content_model.dart';
import '../../../../core/content/toc_extractor.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../core/theme/markdown_theme.dart';
import '../../../../core/layout/layout_shell.dart';
import '../../../../core/widgets/table_of_contents.dart';

/// 通用阅读页面
/// 根据传入的文件名加载并显示对应的 Markdown 内容
class ReaderPage extends StatefulWidget {
  /// 要加载的内容文件名（不包含 .md 扩展名）
  final String filename;

  /// 是否使用古籍正文样式（更大的字号和行距）
  final bool useClassicStyle;

  /// 是否显示目录
  final bool showToc;

  const ReaderPage({
    super.key,
    required this.filename,
    this.useClassicStyle = false,
    this.showToc = false,
  });

  @override
  State<ReaderPage> createState() => _ReaderPageState();
}

class _ReaderPageState extends State<ReaderPage> {
  ContentModel? _content;
  bool _isLoading = true;
  String? _error;
  List<TocItem> _tocItems = [];

  @override
  void initState() {
    super.initState();
    _loadContent();
  }

  @override
  void didUpdateWidget(ReaderPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 如果文件名改变，重新加载内容
    if (oldWidget.filename != widget.filename) {
      _loadContent();
    }
  }

  /// 加载内容
  Future<void> _loadContent() async {
    setState(() {
      _isLoading = true;
      _error = null;
    });

    try {
      final rawContent = await ContentLoader.loadContent(widget.filename);

      // 首先尝试从 Frontmatter 中提取标题
      final content = ContentParser.parse(rawContent);

      // 如果 Frontmatter 中没有标题，尝试从内容中提取第一个标题
      String finalTitle = content.title;
      if (finalTitle == '无标题') {
        final extractedTitle = ContentParser.extractFirstHeading(
          content.content,
        );
        if (extractedTitle != null) {
          finalTitle = extractedTitle;
        } else {
          // 如果还是没有标题，使用文件名
          finalTitle = _formatFilename(widget.filename);
        }
      }

      // 提取目录
      final tocItems = TocExtractor.extractToc(content.content);

      setState(() {
        _content = content.copyWith(title: finalTitle);
        _tocItems = tocItems;
        _isLoading = false;
      });
    } catch (e) {
      setState(() {
        _error = '加载内容失败: $e';
        _isLoading = false;
      });
    }
  }

  /// 格式化文件名为标题
  String _formatFilename(String filename) {
    // 移除 .md 扩展名
    String name = filename.replaceAll('.md', '');

    // 将下划线替换为空格
    name = name.replaceAll('_', ' ');

    // 首字母大写
    if (name.isNotEmpty) {
      name = name[0].toUpperCase() + name.substring(1);
    }

    return name;
  }

  @override
  Widget build(BuildContext context) {
    return LayoutShell(
      title: _content?.title,
      showBackButton: false,
      child: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_isLoading) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.error_outline, size: 48, color: AppTheme.vermilionRed),
              const SizedBox(height: 16),
              Text(
                _error!,
                style: Theme.of(context).textTheme.bodyLarge,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 24),
              ElevatedButton(onPressed: _loadContent, child: const Text('重试')),
            ],
          ),
        ),
      );
    }

    if (_content == null) {
      return const Center(child: Text('内容为空'));
    }

    return _buildContent();
  }

  Widget _buildContent() {
    // 判断是否显示 TOC（桌面端且有目录项，且参数指定显示）
    final showToc =
        widget.showToc &&
        MediaQuery.of(context).size.width >= 1200 &&
        _tocItems.isNotEmpty &&
        _tocItems.length >= 3; // 至少3个标题才显示TOC

    if (showToc) {
      return Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 主内容区
          Expanded(child: _buildMainContent()),
          // 目录侧边栏
          TableOfContents(items: _tocItems),
        ],
      );
    }

    return _buildMainContent();
  }

  Widget _buildMainContent() {
    return SingleChildScrollView(
      primary: true, // 使用浏览器原生滚动条
      child: Column(
        children: [
          // 主内容区
          Align(
            alignment: Alignment.topCenter,
            child: Container(
              constraints: BoxConstraints(
                maxWidth: AppTheme.getContentMaxWidth(context),
              ),
              padding: AppTheme.getContentPadding(context),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // 标题（如果需要显示的话）
                  if (_shouldShowTitle())
                    Padding(
                      padding: const EdgeInsets.only(bottom: 32),
                      child: Text(
                        _content!.title,
                        style: Theme.of(context).textTheme.displayLarge,
                        textAlign: TextAlign.center,
                      ),
                    ),

                  // 元数据（日期等）
                  if (_content!.createdAt != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 24),
                      child: _buildMetadata(),
                    ),

                  // Markdown 内容
                  MarkdownBody(
                    data: _content!.content,
                    styleSheet: widget.useClassicStyle
                        ? MarkdownTheme.getClassicTextStyleSheet(context)
                        : MarkdownTheme.getStyleSheet(context),
                    selectable: true,
                    onTapLink: (text, href, title) {
                      if (href != null) {
                        // 处理内部页面链接
                        if (href.startsWith('/')) {
                          context.go(href);
                        } else if (href.startsWith('http://') ||
                            href.startsWith('https://')) {
                          // 外部链接，使用浏览器打开
                          final uri = Uri.parse(href);
                          canLaunchUrl(uri).then((canLaunch) {
                            if (canLaunch) {
                              launchUrl(
                                uri,
                                mode: LaunchMode.externalApplication,
                              );
                            } else {
                              if (context.mounted) {
                                ScaffoldMessenger.of(context).showSnackBar(
                                  SnackBar(content: Text('无法打开链接: $href')),
                                );
                              }
                            }
                          });
                        } else {
                          // 处理相对链接（通常是跳转到另一个 Markdown 文件）
                          // 例如 [第一阶段](phase1) -> /read?file=phase1
                          context.go('/read?file=$href');
                        }
                      }
                    },
                  ),

                  // 标签
                  if (_content!.tags != null && _content!.tags!.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 32),
                      child: _buildTags(),
                    ),

                  // 底部间距
                  const SizedBox(height: 48),
                ],
              ),
            ),
          ),
          // 页脚 - 在滚动内容区域内
          LayoutShell.buildFooter(context),
        ],
      ),
    );
  }

  /// 判断是否应该显示独立的标题
  /// 如果内容的第一行就是标题，则不需要额外显示
  bool _shouldShowTitle() {
    if (_content == null) return false;

    final firstLine = _content!.content.trim().split('\n').first.trim();
    return !firstLine.startsWith('#');
  }

  Widget _buildMetadata() {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (_content!.createdAt != null) ...[
          Icon(
            Icons.calendar_today_outlined,
            size: 16,
            color: AppTheme.secondaryGray,
          ),
          const SizedBox(width: 4),
          Text(
            _formatDate(_content!.createdAt!),
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ],
    );
  }

  Widget _buildTags() {
    return Wrap(
      alignment: WrapAlignment.center,
      spacing: 8,
      runSpacing: 8,
      children: _content!.tags!.map((tag) {
        return Chip(
          label: Text(tag),
          backgroundColor: AppTheme.paperBackground,
          side: BorderSide(color: AppTheme.borderColor),
          labelStyle: Theme.of(
            context,
          ).textTheme.bodySmall?.copyWith(color: AppTheme.inkBlack),
        );
      }).toList(),
    );
  }

  String _formatDate(DateTime date) {
    return '${date.year}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}';
  }
}
