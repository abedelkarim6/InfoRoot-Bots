"""
Utility functions for handling linked topics and keyword expansion
"""

def get_expanded_keywords(category_name, all_categories, visited=None):
    """
    Get all keywords for a category, including keywords from linked topics.
    
    Args:
        category_name: Name of the category
        all_categories: Dict of all categories (from both countries and regions)
        visited: Set of visited categories (to prevent circular references)
    
    Returns:
        List of unique keywords
    """
    if visited is None:
        visited = set()
    
    # Prevent infinite loops from circular references
    if category_name in visited:
        return []
    
    visited.add(category_name)
    
    # Get the category
    category = all_categories.get(category_name)
    if not category:
        return []
    
    # Start with the category's own keywords
    keywords = set(category.get('keywords', []))
    
    # Add keywords from linked topics
    linked_topics = category.get('linked_topics', [])
    for topic_name in linked_topics:
        linked_keywords = get_expanded_keywords(topic_name, all_categories, visited.copy())
        keywords.update(linked_keywords)
    
    return list(keywords)


def build_category_lookup(config):
    """
    Build a combined lookup of all categories from config.
    
    Args:
        config: Full configuration dict with categories
    
    Returns:
        Dict with all categories from countries and regions
    """
    all_categories = {}
    
    # Merge countries and regions
    if 'categories' in config:
        if 'countries' in config['categories']:
            all_categories.update(config['categories']['countries'])
        if 'regions' in config['categories']:
            all_categories.update(config['categories']['regions'])
    
    return all_categories


def get_category_keywords_with_links(group, name, config):
    """
    Get all keywords for a category including linked topics.
    
    Args:
        group: 'countries' or 'regions'
        name: Category name
        config: Full configuration dict
    
    Returns:
        List of unique keywords
    """
    all_categories = build_category_lookup(config)
    return get_expanded_keywords(name, all_categories)


def validate_linked_topics(group, name, linked_topics, config):
    """
    Validate that linked topics exist and don't create circular references.
    
    Args:
        group: 'countries' or 'regions'
        name: Category name
        linked_topics: List of topic names to link
        config: Full configuration dict
    
    Returns:
        Tuple of (is_valid, error_message)
    """
    all_categories = build_category_lookup(config)
    
    for topic_name in linked_topics:
        # Check if topic exists
        if topic_name not in all_categories:
            return False, f"Topic '{topic_name}' does not exist"
        
        # Check for circular reference
        if topic_name == name:
            return False, "Cannot link a topic to itself"
        
        # Check if the linked topic links back (direct circular ref)
        linked_topic = all_categories[topic_name]
        if name in linked_topic.get('linked_topics', []):
            return False, f"Circular reference detected: '{name}' and '{topic_name}' link to each other"
    
    return True, None


# Example usage in your message processing:
"""
from utils.linked_topics import get_category_keywords_with_links

def check_message_matches_category(message, group, category_name, config):
    # Get expanded keywords (includes linked topics)
    keywords = get_category_keywords_with_links(group, category_name, config)
    
    # Check if message contains any keyword
    message_lower = message.lower()
    for keyword in keywords:
        if keyword.lower() in message_lower:
            return True
    
    return False
"""


def get_topic_keywords_recursive(topic_dict, parent_keywords=None):
    """
    Recursively collect keywords from topic and all ancestors.

    Args:
        topic_dict: The topic configuration dict
        parent_keywords: List of keywords inherited from parent topics

    Returns:
        List of all keywords (own + inherited)
    """
    if parent_keywords is None:
        parent_keywords = []

    # Combine parent keywords with own keywords
    own_keywords = topic_dict.get('keywords', [])
    all_keywords = list(set(parent_keywords + own_keywords))

    return all_keywords


def flatten_topics_with_hierarchy(topics_dict, parent_keywords=None, path="", max_depth=5, current_depth=0):
    """
    Flatten nested topics into flat dict with computed keywords.

    Args:
        topics_dict: Dict of topics (can contain sub_topics)
        parent_keywords: List of keywords inherited from parent
        path: Current path (e.g., "middle_east/lebanon")
        max_depth: Maximum nesting depth to prevent infinite recursion
        current_depth: Current depth level

    Returns:
        Dict of {full_path: {keywords, schedules, enabled}}
    """
    if parent_keywords is None:
        parent_keywords = []

    if current_depth >= max_depth:
        return {}

    result = {}

    for topic_name, topic_data in topics_dict.items():
        current_path = f"{path}/{topic_name}" if path else topic_name
        current_keywords = get_topic_keywords_recursive(topic_data, parent_keywords)

        # Add this topic
        result[current_path] = {
            'keywords': current_keywords,
            'schedules': topic_data.get('schedules', []),
            'enabled': topic_data.get('enabled', True)
        }

        # Recursively process sub-topics
        if 'sub_topics' in topic_data:
            sub_result = flatten_topics_with_hierarchy(
                topic_data['sub_topics'],
                current_keywords,  # Pass keywords down
                current_path,
                max_depth,
                current_depth + 1
            )
            result.update(sub_result)

    return result
