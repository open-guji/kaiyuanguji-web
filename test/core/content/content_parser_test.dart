import 'package:flutter_test/flutter_test.dart';
import 'package:kaiyuanguji/core/content/content_parser.dart';

void main() {
  group('ContentParser', () {
    test('should parse title and content correctly when author is absent', () {
      const rawContent = '''---
title: Test Title
date: 2024-01-01
tags: [tag1, tag2]
---
# Main Heading
Body text.''';

      final content = ContentParser.parse(rawContent);

      expect(content.title, equals('Test Title'));
      expect(content.content, contains('Body text.'));
      expect(content.createdAt, isA<DateTime>());
      expect(content.tags, contains('tag1'));
      // No author field exists anymore, so we don't check for it.
    });

    test('should ignore author field if it exists in frontmatter', () {
      const rawContent = '''---
title: Test Title
author: Should Be Ignored
---
Body text.''';

      final content = ContentParser.parse(rawContent);

      expect(content.title, equals('Test Title'));
      expect(content.content, equals('Body text.'));
      // There's no author field on the model anymore.
    });
  });
}
