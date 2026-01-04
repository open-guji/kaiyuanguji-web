import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:go_router/go_router.dart';
import '../../../../core/content/content_loader.dart';
import '../../../../core/content/content_parser.dart';
import '../../../../core/content/content_model.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../core/theme/markdown_theme.dart';
import '../../../../core/layout/layout_shell.dart';

/// 首页
/// 展示项目简介和主要内容
class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  ContentModel? _content;
  bool _isLoading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadContent();
  }

  /// 加载首页内容
  Future<void> _loadContent() async {
    try {
      // 尝试加载 home.md，如果不存在则使用默认内容
      String rawContent;
      try {
        rawContent = await ContentLoader.loadContent('home');
      } catch (e) {
        // 如果 home.md 不存在，使用默认欢迎内容
        rawContent = _getDefaultContent();
      }

      final content = ContentParser.parse(rawContent, defaultTitle: '开元古籍');

      setState(() {
        _content = content;
        _isLoading = false;
      });
    } catch (e) {
      setState(() {
        _error = '加载内容失败: $e';
        _isLoading = false;
      });
    }
  }

  /// 获取默认内容
  String _getDefaultContent() {
    return '''---
title: 开源古籍
---

这是一个致力于古籍数字化与传播的项目。

## 项目愿景

构建一个从"数字化排版"到"高精度校对"的闭环系统。利用 **Flutter** 的跨平台能力解决多端访问问题，结合 **LaTeX** 的专业排版能力还原古籍之美，旨在降低古籍数字化、标准化与传播的门槛。

## 核心功能

- 古籍排版引擎
- 高效率校对工具
- 图文对照系统
- 多平台支持
''';
  }

  @override
  Widget build(BuildContext context) {
    return LayoutShell(title: '开源古籍', child: _buildBody());
  }

  Widget _buildBody() {
    if (_isLoading) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_error != null) {
      return Center(
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
            ElevatedButton(
              onPressed: () {
                setState(() {
                  _isLoading = true;
                  _error = null;
                });
                _loadContent();
              },
              child: const Text('重试'),
            ),
          ],
        ),
      );
    }

    if (_content == null) {
      return const Center(child: Text('内容为空'));
    }

    return _buildContent();
  }

  Widget _buildContent() {
    return SingleChildScrollView(
      primary: true, // 使用浏览器原生滚动条
      child: Align(
        alignment: Alignment.topCenter,
        child: Container(
          constraints: BoxConstraints(
            maxWidth: AppTheme.getContentMaxWidth(context),
          ),
          padding: AppTheme.getContentPadding(context),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // 标题
              if (_content!.title.isNotEmpty)
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
                styleSheet: MarkdownTheme.getCenteredStyleSheet(context),
                selectable: true,
                onTapLink: (text, href, title) {
                  if (href != null) {
                    // 处理内部链接
                    if (href.startsWith('/')) {
                      context.go(href);
                    } else if (href.startsWith('http://') ||
                        href.startsWith('https://')) {
                      // 外部链接显示提示
                      ScaffoldMessenger.of(
                        context,
                      ).showSnackBar(SnackBar(content: Text('外部链接: $href')));
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
    );
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
